# CareerOS glossary

Plain definitions of the terms the team uses in specs, reviews and conversations. It was generated from the prompt in [PROMPTS.md](PROMPTS.md#6-glossary). The root [GLOSSARY.md](../../GLOSSARY.md) is a different file: it is the translators' guide to interface strings and stays as it is.

**Active organization.** The organization a session is currently acting in. On an org host it is always that host's organization.

**AI credits.** The unit of platform AI use. An organization's pool is the plan's credits per seat times the larger of paid seats and members, per billing period. Code: `@careeros/ai-metering`.

**Announcement.** A dismissible banner a platform admin publishes from `/admin`. Tables `announcement`, `announcement_dismissal`.

**Audit log.** The append-only `audit_log` table. The app can add rows but never change or delete them. Owners and admins see their organization's entries; platform admins see all.

**Board token.** The name of a company's job board on Greenhouse, Lever or Ashby. Discovery accepts only tokens, never free URLs, so it cannot be pointed at an internal address.

**Branding gate.** The CI check (`tooling/careeros/branding-gate.mjs`) that fails when the upstream product name or its links appear in user-visible code.

**BYO key.** Bring your own key: a member's own AI provider key, saved encrypted. Calls on it are logged at zero cost and never use credits. An organization-level BYO key is planned, not built.

**CAREEROS: marker.** The comment that marks every edit inside an upstream file, with the reason. Every such file is listed in `docs/UPSTREAM_PATCHES.md`.

**careeros_app.** The database role the app serves traffic as. Not a superuser, cannot bypass row-level security, owns no tables.

**careeros_owner.** The database role that owns the tables and runs migrations.

**Clipper token.** The credential the Job Clipper gets after device sign-in. Hashed, bound to one org host, valid for 90 days on a sliding basis, and revocable. Table `clipper_token`.

**Cohort.** A group of members inside an organization, such as a class or intake, used to filter analytics and invitations. Table `cohort`.

**Cross-org fuzz.** Test suites that replay real routes using another organization's ids or host and expect 404 every time (P1-Q03, P1-Q10, P2-Q01).

**Custom domain.** An organization's own hostname, verified by a TXT record and served through Cloudflare for SaaS. Table `organization_domain`.

**Decision ids.** `D<n>` is a decision in a phase plan, `G<n>` in the go-to-market plan, `E<n>` an escalation to Stephen, and `Q<n>` a question in `docs/questions.md`.

**Definer function.** A PostgreSQL `SECURITY DEFINER` function with a pinned `search_path`. It is the only way the app changes protected data such as plans, subscriptions and platform audit rows, and it writes an audit row in the same transaction.

**Device flow.** The OAuth 2.0 device authorization flow the Job Clipper uses to sign in: the member approves a code on their organization's `/device` page.

**Discovery run.** One execution of a job source: fetch, de-duplicate, score, then AI-score the top N. Table `discovery_run`.

**Discovered job.** A job found by a run, waiting in the review queue. Dismissed is a status, so it never returns. Table `discovered_job`.

**Entitlements.** What an organization may do right now: plan, status, seats, credits, features and read-only state. Answered by `getEntitlements(orgId)` in `@careeros/billing`.

**Escalation.** A decision only Stephen can make (business, spending, destructive actions), logged in `docs/ESCALATIONS.md`.

**Feature flag.** A row in `feature_flag` that turns a feature on or off globally or for one organization. Resolution order: organization flag, plan features, global flag, code default.

**FORCE RLS.** `FORCE ROW LEVEL SECURITY`, which applies the policy even to the table owner. Every tenant table has it.

**Grace period.** Seven days after a failed payment during which a `past_due` organization keeps working, before it is suspended.

**Handoff.** The one-time, host-bound step that completes social or OIDC sign-in on an org host, because providers only redirect to the platform host. Table `auth_handoff`.

**Isolation registry.** The list in `packages/isolation-testing/src/registry.ts` of every tenant table, with a seed function. CI fails if a table with `organization_id` is missing.

**Job Clipper.** The CareerOS browser extension for Chrome and Edge that saves a job posting from any page into the tracker. Code: `apps/extension`.

**Job source.** A member's saved job search (titles, skills, locations, boards, schedule). Table `job_source`.

**Member roles.** Inside an organization: `owner` (billing, branding, domains, admins), `admin` (members, cohorts, analytics, templates) and `member` (their own data). A coach role is planned for v1.1.

**Metering.** Recording every platform AI call in `ai_usage` with tokens and cost, and enforcing the 80% notice and 100% stop.

**Org host.** An organization's address built from `ORG_HOST_PATTERN`, for example `<slug>-careeros.ayopa.co.ke` on staging. The host decides the organization.

**Organization.** A tenant: one customer, with its own members, data, branding and plan. Table `organization`.

**Personal organization.** The workspace every user gets at sign-up, unless they join through an invitation or an org host. It is on the free `personal` plan and has no admin pages.

**Plan.** A row in `plan` with prices, seat limit, AI credits per seat and features. Starter, Pro and Enterprise are seeded with placeholder prices until D2 is decided.

**Platform admin.** A CareerOS staff member with the Better Auth admin role and two-factor authentication on. Uses the Super Admin console at `/admin`. Granted only with `tooling/careeros/platform-admin.mjs`.

**Platform AI.** AI calls paid for by CareerOS's own Claude key (`ANTHROPIC_API_KEY`) and counted against the organization's credits.

**Platform host.** The main address (`APP_URL`). It hosts the Super Admin console, webhooks and personal workspaces.

**Review.** Opus's report on a PR, saved as `docs/reviews/<ID>-review-<n>.md`, with findings rated Critical, High, Medium or Low.

**Review queue.** The list under Career, Jobs where a member saves or dismisses discovered jobs.

**RLS.** Row-level security: a PostgreSQL policy on each tenant table that shows only rows whose `organization_id` matches `app.current_org_id`.

**Seat.** One member or one pending, unexpired invitation. The plan or subscription sets the limit.

**Slug.** The short name in an organization's address. Personal workspaces get `u-<id suffix>`.

**Spec.** A task specification by Opus in `docs/plans/`. Sonnet codes only specs marked Approved.

**Support session.** A platform admin acting as an organization owner for up to 60 minutes, on that organization's host, with a banner and audit rows. Table `impersonation`.

**Suspended.** An organization status in which members can sign in and export but every write is refused with `ORG_SUSPENDED`.

**Task ids.** `P<phase>-T<nn>` for build, `-Q` for QA, `-C` for CI/CD, `-M` for marketing site; a trailing letter (P2-T03a) is a follow-up.

**Tenant table.** Any table holding organization data. It has `organization_id text not null`, forced RLS, the `tenant_isolation` policy and a registry entry.

**Test plan.** Opus's list of test cases for a task, in `docs/test-plans/`.

**Trial.** The first 14 days of an organization on a paid plan, before payment.

**Upstream sync.** The monthly merge of a new Reactive Resume release into CareerOS, through an `upstream-sync` branch, tests and an Opus review.

**withOrgContext.** The function in `@careeros/tenancy` that runs code with one database client set to an organization, so RLS applies to every query inside.
