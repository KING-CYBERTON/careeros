# Phase 1 exit: Opus security sign-off review 1

**Reviewer:** Opus (Thread 1), 2026-11-01. **Scope:** `develop` at `0794338` (after #39), covering P1-T01 to T09, P1-C01 and P1-Q01 to Q09.
**Verdict:** No open Critical or High findings. **Signed off** on 2026-11-01: P1-Q10 (M1) merged green in [#42](https://github.com/KING-CYBERTON/careeros/pull/42) with no leaks. The Low items go to the backlog.

## Method

1. **Database introspection.** I built a fresh database by applying all 56 shipped migrations in order, then ran `infra/db/bootstrap-roles.sql`. I then checked these catalogs:
   - `pg_class`: RLS and FORCE RLS.
   - `pg_attribute`: `organization_id NOT NULL`.
   - `pg_policies`.
   - `pg_proc`: security-definer functions, their `proconfig` and ACLs.
   - `pg_roles`.
2. **Definer function bodies.** I read every function whose ACL grants EXECUTE to `careeros_app`. There are 25.
3. **Request path code.**
   - `packages/tenancy` (`withOrgContext`, `captureOrgScope`, `resolveOrgForRequest`).
   - `protectedProcedure` in `packages/api/src/context.ts`.
   - The startup role check.
   - The Better Auth organization config.
   - Every runtime use of `DATABASE_MIGRATION_URL`.
4. **Prior evidence.**
   - P1-Q03 fuzzed 157 id-taking operations (332 requests) and 106 MCP tools, with no leaks.
   - The unclassified-tables check has an empty pending list.
   - The T04 to T09 reviews have no open findings.

## What holds

- **Tables.** All 33 tenant tables have RLS enabled and forced, a NOT NULL `organization_id`, and exactly two policies: `tenant_isolation` (`organization_id = current_setting('app.current_org_id', true)`, USING and WITH CHECK) and `owner_access` for the migrating role. When the setting is unset, the policy evaluates to NULL, so no rows match. The policy fails closed.
- **Non-RLS tables.** The 19 tables without RLS are Better Auth and global tables, all classified in `globalTables`: `user`, `session`, `account`, `member`, `organization`, `invitation`, `apikey`, `oauth_*`, `passkey`, `two_factor`, `verification`, `jwks` and `released_username`.
- **Definer functions.** All 26 have `search_path = pg_catalog, public`.
  - 25 of them grant EXECUTE only to the owner and `careeros_app`. The 26th, `enqueue_account_storage_cleanup`, is a trigger function with owner-only EXECUTE. PUBLIC has no EXECUTE on any of them.
  - The public lookups return only public data: public resumes, verified domains and counts.
  - The D9 listers return only `(id, organization_id)` pairs or org ids.
  - The guest moves require an anonymous source account and the target user's membership in the target org.
  - `careeros_release_domain_claims` requires the current org and the caller's own claim row (T09 H1).
- **Roles.** `careeros_app` is NOSUPERUSER, NOBYPASSRLS, owns no tables and has no CREATE privilege. The startup check refuses to boot when the runtime role is the owner, a superuser or BYPASSRLS.
- **Request org.**
  - The request's org comes only from authenticated server state: the session's active org, or the API key's org. A `member` row is required in both cases.
  - Headers and body are never used to pick the org.
  - When no org can be resolved, `protectedProcedure` throws FORBIDDEN (`ORG_CONTEXT_REQUIRED`).
  - The client goes back to the pool only after the setting resets. On any error it is destroyed instead.
  - A scope refuses to switch org and refuses use after it closes.
- **Owner role use.** At runtime, the owner role is only used for the startup checks and the one-off legacy-style script.

## Findings

### M1 (Medium, gates sign-off): Better Auth organization endpoints are not fuzzed

`member`, `organization` and `invitation` have no RLS by design, so isolation there rests on the Better Auth organization plugin plus our `organizationRules`. The P1-Q03 fuzz enumerates the oRPC router and MCP tools but not `/api/auth/organization/*`. Examples of the uncovered endpoints:

- get-full-organization, list-members, list-invitations, get-invitation
- update, delete
- add, remove and update member role
- invite, cancel, accept and reject invitation
- set-active
- leave

A regression or misconfiguration there would expose membership data or let a user join or administer another org. Spec: **P1-Q10**. P1-Q10 also covers Q03 follow-up F2, an MCP control call made as A.

### L1 (Low): guest-move functions trust the app role for the caller

`careeros_move_guest_*` refuse non-guest sources and non-member targets, but they cannot prove that the caller is the guest who is linking. If the app role were compromised, for example by SQL injection, it could move any guest's data into any org where it holds a membership. Guests only, and only with a compromised app role. Accepted. Revisit in Phase 2 by passing a one-time link token.

### L2 (Low): `owner_access` binds to whichever role ran the migration

The policy is written `TO CURRENT_USER`, so it names the role that ran the migration. Staging and CI e2e migrate as `careeros_owner`, which is correct. The unit suites migrate as `postgres`, which is harmless there. If someone hand-runs a future migration as a superuser on staging, its policies would name `postgres`, and `careeros_owner`, as table owner under FORCE, would see no rows in those tables. The failure mode is lost availability, not a leak. Backlog: name `careeros_owner` explicitly when that role exists.

### L3 (Low, known): API keys without an org and OAuth tokens fall back to the oldest membership

These are already tracked from the P1-T04 review (M1). Phase 2 replaces them with org-bound keys and tokens.

### L4 (Low, reliability): Q20

`Promise.all` over `db` inside one org-scoped client queues queries on that client. This does not affect isolation, but it blocks a move to pg 9. Spec it before any `pg` upgrade.

### Info

- Make `bindGlobalPoolForTesting` throw in production (Q75).
- Drop the old `careeros_due_storage_cleanup` overload (Q74).
- Add custom domains to the fuzz once the e2e profile enables them (Q03 F1).

## Sign-off

Phase 1 tenant isolation is signed off once P1-Q10 is green with no leaks. The remaining exit items are the BASELINE refresh (P1-C02) and the staging verification, which waits on Stephen's owner actions.
