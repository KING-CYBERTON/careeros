# Phase 2 exit: Opus security review 1

**Reviewer:** Opus (Thread 1), 2026-11-02. **Scope:** `develop` at `423c27f` (after #59 and #56), covering P2-T01 to T08, P2-C01, P2-C02 and P2-Q01/Q02.
**Verdict:** No Critical or High findings. One Medium (M1) gates sign-off, as P1's M1 did: three security-relevant database suites have never run in CI. Spec P2-C03 fixes it. Phase 2 exit (tag `0.2.0`) also waits on the live staging checks for criteria 1 and 2, which need Stephen's Cloudflare and staging actions.

## Method

1. **Database introspection.** I built a fresh database: `infra/db/bootstrap-roles.sh`, then all 60 migrations applied as `careeros_owner`. I checked `pg_class` (RLS and FORCE RLS), `pg_attribute`, `pg_policies`, `pg_proc` (definer functions, `proconfig`, ACLs), `pg_trigger` and `pg_roles`.
2. **Definer function bodies.** I read the eight new Phase 2 functions that `careeros_app` can execute.
3. **Request path.** Host resolution (`@careeros/tenancy` `resolveHost`, `hostTrustedOrigins`), `hostMiddleware` including the Q152 fix, the Better Auth config (trusted origins, cookie scope, the sign-up guard), the handoff routes, the brand shell and the org-domain service.
4. **Prior evidence.** The T01 to T08, C01, C02 and Q01/Q02 reviews have no open findings. The Q01 org-host fuzz pass refused 334 of 334 requests, and the platform pass still shows no leaks. The unclassified-tables pending list is empty.

## What holds

- **Tables.** The three new tenant tables, `organization_branding`, `organization_settings` and `organization_domain`, have RLS enabled and forced, a NOT NULL `organization_id`, and the standard `tenant_isolation` and `owner_access` policies. That brings the RLS tenant tables to 36.
- **New tables without RLS.** Both are classified.
  - `auth_handoff` is pre-auth and on the tenancy allow-list (Q107). It holds hashes only, and redeem is one atomic update checked against the database clock.
  - `organization_domain_cf_cleanup` is a global queue holding only Cloudflare ids and hostnames. It is filled by an owner-only trigger.
- **Definer functions.** All 38 have `search_path = pg_catalog, public`. PUBLIC has EXECUTE on none.
  - The trigger functions (`careeros_organization_domain_guard`, `careeros_org_domain_cf_cleanup_enqueue`, `careeros_custom_domain_guard`) are owner-only.
  - `careeros_public_branding*` returns only public fields: no sender name, no reply-to, no settings.
  - `careeros_org_for_custom_host` resolves only `active` domains, so a pending or failed claim never routes.
  - `careeros_claim_org_domain` and the guard trigger enforce cross-table and cross-org uniqueness under one advisory lock (T06 M1 and M2 fixed).
- **Roles.** `careeros_app` is still NOSUPERUSER, NOBYPASSRLS and NOCREATEROLE, and owns no tables.
- **Host decides the org (D4).**
  - The org comes from `HostContext`, never from headers or the body. `X-Forwarded-Host` is ignored unless `TRUST_FORWARDED_HOST` is set (default false). Cloudflare Tunnel passes the original `Host`, so staging needs no trust.
  - On an org host the session must belong to that org, otherwise the request gets `ORG_HOST_NOT_MEMBER`. API keys must match the host's org (`ORG_HOST_KEY_MISMATCH`).
  - Unknown org hosts fail closed with a 404, `noindex`, and only the built web files.
  - `ORG_HOST_PATTERN` cannot match the platform host (startup check).
- **Sessions (D5).** No cookie `Domain` attribute and no cross-subdomain cookies. `trustedOrigins` adds only the request's own origin, and only when it resolves to an org host. The handoff is bound to the host, the browser and the user, and is single use (T05 review).
- **Branding (D9).** Branding is chosen by host, with `Vary: Host` and a per-org cache tag. Every injected value is escaped or validated (T02 review). Q02 checks the raw HTML both ways for brand leakage.
- **Secrets.** The Cloudflare tokens come from the environment only. The staging script scrubs them from all output, and the infra token never reaches the app.

## Findings

### M1 (Medium, gates sign-off): the org-host, email-link and handoff database suites skip in CI

The develop run 41404157247 skipped `packages/auth/src/org-host.integration.test.ts` (13 tests), `packages/auth/src/email-links.integration.test.ts` (6) and `apps/server/src/http/handoff.integration.test.ts` (24). These suites need `CAREEROS_TEST_DATABASE_URL` and `CAREEROS_TEST_APP_DATABASE_URL`. The unit job sets both, but Turborepo strict env mode hides them, because `packages/auth/turbo.json` and `apps/server/turbo.json` do not list them (`packages/api/turbo.json` does).

So the T03 sign-up guard and trusted origins, the T04 link-host rules and the T05 handoff (replay, binding, open redirect) were verified only on agents' machines. The e2e handoff spec and the Q01 suite cover parts of this in CI, so this is not a known hole, but the deepest tests of the riskiest Phase 2 piece are not guarding regressions.

Spec: **P2-C03**. It passes the variables through, makes the suites pass, and adds a CI guard that fails when an integration suite is skipped.

### L1 (Low, record only): `careeros_email_branding` returns the sender fields for any org id

The function returns `email_from_name` and `email_reply_to` for whatever org id the app role passes. Only the email sender calls it, with the org resolved from the flow, and no API returns its output. These fields are not secret, but they are not public either. Accepted. If the function ever gains another caller, scope it to the current org.

### L2 (Low, backlog): a released org slug can be taken by another org

Owners can change the org slug. The host cache is busted on change, so the old host stops resolving at once, but another org can then take the freed slug and receive traffic from old links and emails. Sessions do not carry over (cookies are host-only, and membership is checked). Phase 3 follow-up: hold released org slugs for a period, as `released_username` does for users.

## Exit notes (accepted, not findings)

- **Q130:** mobile join on an org host is deferred to Phase 3, pending a first-party-client check for bearer tokens. The phone shows the blocked sheet.
- **Q105:** org-aware OAuth state, so that invite-only orgs can refuse sign-up upstream, is a Phase 3 follow-up.
- **Mobile native identity (Q80):** a store-release blocker, recorded in STATUS. It does not gate the `0.2.0` exit, because the mobile changes in this phase are OTA only.

## Exit criteria status

| #   | Criterion                                          | Status                                                                                                                   |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Two orgs, distinct branding on every surface       | Proven in CI (P2-Q02, #59). Waits on the live staging check after the P2-C01 owner actions.                              |
| 2   | Custom domain verifies, gets TLS, stops on removal | Built and unit-tested (T06, T07). Waits on Stephen enabling Cloudflare for SaaS, the two tokens, and a live test domain. |
| 3   | Host decides the org; A's session cannot act in B  | Met (P2-Q01, #59: e2e plus the fuzz org-host pass, zero leaks).                                                          |
| 4   | CI gate finds no upstream branding                 | Met (P2-C02, #55).                                                                                                       |
| 5   | No open Critical or High                           | Met (this review). Sign-off waits on M1 (P2-C03).                                                                        |
