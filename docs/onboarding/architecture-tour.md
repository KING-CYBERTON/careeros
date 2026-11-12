# Architecture tour

This tour explains the layer CareerOS adds on top of the upstream resume app: how a request finds its organization, how data stays inside that organization, and how branding, billing, AI, job discovery, the Job Clipper and the consoles fit together. It is for engineers and reviewers. It was generated from the prompt in [PROMPTS.md](PROMPTS.md#3-architecture-tour) and checked against `develop` on 2026-11-11. For the upstream architecture (builder, PDF rendering, oRPC, mobile), see `AGENTS.md` and `docs/contributing/architecture.mdx`.

## 1. A request, end to end

```text
Browser, mobile app or Job Clipper
  |
  v
Cloudflare (DNS, TLS, Cloudflare for SaaS custom hostnames)
  |  staging: Cloudflare Tunnel to the home-lab server, no open inbound ports
  v
Hono server (apps/server)
  1. Resolve the host: platform host, org host (ORG_HOST_PATTERN) or a verified custom domain
  2. Load branding, plan and entitlements for that organization (cached per request)
  3. Check the session user is a member of that organization
  4. withOrgContext(orgId): one pooled client with app.current_org_id set
  |
  v
oRPC procedure or route handler (packages/api) -> Drizzle
  |
  v
PostgreSQL as careeros_app: FORCE row-level security on every tenant table
```

Background work (scheduled discovery runs, reminders, billing period jobs, cleanup) always sets the organization explicitly before it touches tenant rows.

## 2. Tenancy

**Organizations and roles.** Organizations, members and invitations come from the Better Auth organization plugin (`organization`, `member`, `invitation` tables). Inside an organization a member is `owner`, `admin` or `member`. Platform staff are a separate layer: users with the Better Auth admin plugin's `admin` role, who must turn on two-factor authentication before the console opens. Every user gets a **personal organization** at sign-up (named "<name>'s workspace", slug `u-<id suffix>`), unless they sign up through an invitation or on an organization's host, in which case they join that organization instead (`packages/auth/src/personal-org.ts`). A user can belong to several organizations; data is always scoped to the active one.

**The host decides the organization.** `ORG_HOST_PATTERN` holds one `{slug}` (staging uses `{slug}-careeros.ayopa.co.ke`). A request on an org host, or on a verified custom domain in `organization_domain`, acts in that organization only. A session from one organization's host cannot act in another's. The platform host (`APP_URL`) is where the Super Admin console, billing webhooks and personal workspaces live. Unknown org addresses show a "not set up yet" page. The resolver is in `packages/tenancy/src/host.ts` and `resolve.ts`.

**Org context in code.** `withOrgContext(orgId, fn)` in `packages/tenancy/src/context.ts` checks out one database client, sets `app.current_org_id`, binds the global `db` to that client for the duration of `fn`, and resets the setting afterwards. It fails closed: if anything goes wrong the connection is destroyed rather than returned to the pool with a stale setting, and nesting a different organization inside a scope throws. `requireOrgId()` throws outside a scope so an insert never reaches the database without an organization. `captureOrgScope()` records the organization for work that outlives the request, such as agent streams.

**Database roles.** The app never connects as a superuser. `careeros_owner` owns the tables and runs migrations at startup (`DATABASE_MIGRATION_URL`). `careeros_app` serves traffic (`DATABASE_URL`) with no superuser, no `BYPASSRLS` and no table ownership. Startup refuses to run in production if the runtime role could bypass RLS. Both roles are created by `infra/db/bootstrap-roles.sql`.

**Row-level security.** Every tenant table has `organization_id text not null`, RLS enabled and forced, and the `tenant_isolation` policy comparing `organization_id` with `current_setting('app.current_org_id', true)`. With no setting, `careeros_app` sees nothing. Tables the app must read but not write (plans, subscriptions, billing events) grant only `SELECT`, and changes go through `SECURITY DEFINER` functions with a pinned `search_path` that write an audit row in the same transaction.

**Proof.** `@careeros/isolation-testing` seeds a row in Org A and asserts Org B sees zero rows by database and 404 by API, for every registered table, and fails CI if a table with an `organization_id` column is not registered. The cross-org fuzz suites (P1-Q03, P1-Q10, P2-Q01) replay real routes with another organization's ids and hosts.

## 3. White-label

- **Branding data.** `organization_branding` holds app name, logo, favicon, colours, font, email sender, support and legal links. `organization_settings` holds organization-level switches such as open sign-up.
- **Where branding shows.** The server injects the organization's branding into the app shell and web manifest, and `GET /branding/host` answers the mobile app and the Job Clipper. Changing branding needs no rebuild.
- **Emails.** Every email (invitation, verify, reset, change email, career notifications) is sent in the organization's brand and sender name, and its links stay on the host the flow started on.
- **Custom domains.** An owner adds a hostname, proves it with a TXT record and points a CNAME at the Cloudflare for SaaS target (`CF_SAAS_CNAME_TARGET`). Cloudflare issues the certificate. A daily check catches takeovers, and removing a domain stops it serving. Custom domains are a plan feature.
- **Sign-in on org hosts.** Social and OIDC providers redirect only to the platform host, so sign-in on an org host uses a one-time, host-bound handoff (`auth_handoff` table, `/api/careeros/handoff/*`, `/auth/handoff` pages).
- **Upstream branding removed.** The branding gate in CI blocks the upstream name and links in user-visible code. The MIT notice stays in `NOTICE` and on the open-source licenses page.

## 4. Plans, entitlements and billing

- **Tables.** `plan`, `subscription`, `feature_flag`, `audit_log`, `billing_event`, `billing_provider_plan`, all in `@careeros/billing`.
- **Entitlements.** `getEntitlements(orgId)` returns the plan, status, seat limit and seats used, AI credits, resolved feature flags, the overage switch and whether the organization is read-only. Every gate reads it.
- **Feature resolution.** The organization's flag, then the plan's `features`, then the global flag, then the code default (off). The first source with an opinion wins, including an explicit `false`.
- **Seats.** Members plus pending, unexpired invitations. Seats are checked when an invitation is created, accepted, or someone joins through open sign-up; a database trigger refuses a member past the limit even under races (`SEAT_LIMIT_REACHED`).
- **Status.** `organization.status` is `trial`, `active`, `past_due` or `suspended`. A trial lasts 14 days. `past_due` has a 7-day grace period, then becomes `suspended`. A suspended organization can sign in and export but every write route refuses with `ORG_SUSPENDED`. Personal organizations are on a free `personal` plan.
- **Billing core.** One provider-independent state machine handles trial, checkout, renewal, failure, seat changes, cancel and expiry. Webhooks arrive at `POST /api/billing/webhook/:provider` on the platform host only, are verified before anything else, are recorded once in `billing_event`, and resolve the organization only from verified provider metadata. A 15-minute job moves trials, grace periods and periods along.
- **Providers.** `BILLING_PROVIDER` is `none` (default, nothing charged), `fake` (tests and staging only, refused in production), or `paystack` (cards and M-Pesa through one integration, decision D1). Manual payments for institutions are recorded by a platform admin. There is no Stripe adapter yet.
- **Prices.** Seeded plans carry placeholder prices until Stephen sets real ones (D2).

## 5. AI

- **Two ways to pay for AI.** A member can save their own provider key (upstream behaviour, encrypted with `ENCRYPTION_SECRET`). If they have none and their organization's plan includes platform AI, calls use the platform Claude key (`ANTHROPIC_API_KEY`).
- **Models.** `CAREEROS_AI_MODEL_GENERATION` for writing and `CAREEROS_AI_MODEL_FAST` for classification and extraction. Each model needs a price in `packages/ai-metering/src/prices.ts` or calls are refused.
- **Metering.** Every platform call writes an `ai_usage` row with organization, user, feature, model, tokens and cost. Credits are pooled per organization: credits per seat times the larger of paid seats and members. Members see a notice at 80% and calls stop at 100% with `AI_QUOTA_EXCEEDED`, unless a platform admin allows overage. Calls on a member's own key are logged at zero cost and never count.
- **Untrusted text.** Job descriptions, clipped pages and uploaded documents go to the model only inside a delimited data block with an injection-safe system prompt (`ai/data-block.ts` pattern).

## 6. Job discovery and the Job Clipper

**Discovery** (`@careeros/job-discovery`, tables `job_source`, `discovery_run`, `discovered_job`):

- A member creates a search under Career, Jobs: titles, skills, keywords, locations, remote preference, boards and a daily or weekly schedule.
- Boards are Greenhouse, Lever (global and EU) and Ashby. A board is named by its token, never a free URL, and requests go only to an allow-list of hosts over https, with a timeout, a size cap and no cross-host redirects.
- A run fetches, de-duplicates, scores locally, then asks the fast platform model to score only the top N within the plan's quota.
- Results land in a review queue. Saving creates an application in the tracker, and dismissing is a status, so a dismissed job never returns.
- `FLAG_DISABLE_DISCOVERY_SCHEDULER` is the kill switch for scheduled runs. Discovery is a plan feature (`job_discovery`).

**Job Clipper** (`apps/extension`, tables `device_code`, `clipper_token`):

- A Manifest V3 extension for Chrome and Edge with no product branding in the package. On first run the member enters their organization's address, and the popup shows that organization's name, logo and colour.
- Sign-in uses the device authorization flow: the member approves on the organization's `/device` page and the extension gets a hashed, host-bound token that lasts 90 days on a sliding basis. Tokens are revoked from Connected apps, and on member removal, account deletion, ban or password reset.
- Clipping reads `JobPosting` JSON-LD first, then the page title and text as a best guess (text only, never HTML). The member confirms the form, and it is saved as a `saved` application with source `clipper`. "Tidy with AI" is optional, metered and needs platform AI.
- Permissions are `activeTab`, `storage` and `scripting`, plus optional access to the one organization origin.

## 7. Consoles

- **Super Admin console** at `/admin`, on the platform host only (every org host answers 404). It has Organizations (list, open, suspend or reactivate, change plan and seats, allow AI overage, record a manual payment), Metrics (counts, MRR, revenue, AI cost), Audit (every organization), Announcements and Email (send a test email). Support sessions let an admin act as one of an organization's owners for at most 60 minutes, on that organization's host, with a banner and an audit row at start and end. Admins are granted only with `tooling/careeros/platform-admin.mjs` on the owner database connection; the app has no promote endpoint. Code: `@careeros/platform-admin`, tables `announcement`, `announcement_dismissal`, `impersonation`.
- **Org Admin pages** for owners and admins, inside Settings: Members & invites (including bulk CSV with a dry run), Branding, Domains, Cohorts, Analytics, AI usage, Audit log, Org email templates, and Billing at `/dashboard/organization/billing`. Consoles and billing purchase are web-only. Mobile shows billing read-only (decision D10).

## 8. Email delivery

`EMAIL_PROVIDER` is `plunk`, `smtp` or `log`. With nothing set it is `smtp` when the SMTP values are complete, otherwise emails are only logged. Plunk is used through its HTTP API with idempotency keys. Bounces and complaints arrive at `POST /api/email/webhook/plunk` with a shared-secret header and go into `email_suppression`, a global, hash-only list written only through definer functions.

## 9. Where is it

| Concern                                        | Package or folder                                                               | Start with                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Org context, host resolution                   | `packages/tenancy`                                                              | `src/context.ts`, `src/host.ts`                                   |
| Personal org, sign-up on org hosts, seat hooks | `packages/auth`                                                                 | `src/personal-org.ts`, `src/organization-enforcement.ts`          |
| Tenant tables                                  | `packages/db`                                                                   | `src/schema/*.ts`, migrations in `migrations/`                    |
| Database roles                                 | `infra/db`                                                                      | `bootstrap-roles.sql`                                             |
| Branding, domains, handoff APIs                | `packages/api/src/features`                                                     | `branding`, `org-domain`, `auth-handoff`, `organization-host`     |
| Entitlements, billing, audit                   | `packages/billing`                                                              | `src/entitlements.ts`, `src/state.ts`, `src/providers/`           |
| AI metering                                    | `packages/ai-metering`                                                          | `src/quota.ts`, `src/prices.ts`                                   |
| Job discovery                                  | `packages/job-discovery`, `packages/discovery-form`                             | `src/run.ts`, `src/http.ts`                                       |
| Job Clipper                                    | `apps/extension`, `packages/api/src/features/clipper`                           | `apps/extension/README.md`                                        |
| Email templates per stage                      | `packages/email-templates`                                                      | `src/built-ins.ts`                                                |
| Super Admin                                    | `packages/platform-admin`, `apps/web/src/routes/admin`                          | `src/admin.ts`, `src/impersonation.ts`                            |
| Org Admin                                      | `packages/api/src/features/org-admin`, `apps/web/src/routes/dashboard/settings` | `route.tsx` for page labels                                       |
| Isolation proof                                | `packages/isolation-testing`, `packages/careeros-testing`                       | `src/registry.ts`                                                 |
| CI guards                                      | `tooling/careeros`                                                              | `branding-gate.mjs`, `skipped-db-suites.mjs`, `release-guard.mjs` |
| Staging                                        | `infra/staging`                                                                 | `README.md`                                                       |

## 10. Planned but not built yet

These are in PRODUCT.md but not in the code on `develop` as of this writing. Check STATUS.md for the current state.

- A screen to create another organization or rename an organization's address (slug). Today the owner's first organization is the personal one from sign-up.
- Phase 4 remainder: question bank, job timeline, company pages and watchlist, tasks and timer, and pushing recommended companies to cohorts (P4-T04).
- Phase 5 remainder: the coaching layer (weekly goals, next step, stage checklists) and the broader licensed job feed (Adzuna and regional boards).
- Phase 6: production environment (G8), backups and restore drill (G9), monitoring (G11), load test, pilot organization.
- P1 platform items: SSO for organizations (SAML or OIDC), the dedicated single-tenant tier (`SINGLE_TENANT=true`), BYO key at organization level, Stripe.
- The coach role (v1.1) and per-organization branded clipper builds (v2).
