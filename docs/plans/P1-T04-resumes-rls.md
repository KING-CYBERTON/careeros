# P1-T04: Resumes batch, backfill and RLS on

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 1 Build, plus Thread 2 for the isolation entries · **Phase plan:** [P1-PHASE-PLAN.md](P1-PHASE-PLAN.md) (D4, D7, D10) · **Depends on:** P1-T03 merged

## Goal

The first tenant tables get RLS: `resume`, `resume_version`, `resume_slug_redirect`, `resume_statistics` and `resume_statistics_daily`. Every existing user gets a personal org (D7), and `ORG_CONTEXT_REQUIRED` becomes `true`.

## Migration (one generated migration plus hand-written SQL in the same folder)

1. **Backfill orgs (D7).**
   - For every `user` without a membership, create an org like the one T03's signup hook makes, plus an `owner` member row.
   - Set `session.active_organization_id` where it is null.
   - The migration must be idempotent and run as the owner role.
2. **Per table:**
   - Add `organization_id text`.
   - Backfill it from the owning user's personal org: through `user_id`, or through `resume_id` for child tables.
   - Set it `not null` and add an FK to `organization(id) on delete cascade`.
   - Add the composite indexes, leading with `organization_id`. Replace the user-led indexes only where a query needs them.
   - Run `enable` and `force row level security`, then add the `tenant_isolation` policy (D4).
   - Grant to `careeros_app` as the existing grants do.
3. **Down migration:** drop the policies, columns and backfilled orgs. Mark backfilled orgs with `metadata = '{"careeros_backfill":true}'` so the down migration can find them.

## Application code

4. **Inserts set `organization_id = currentOrgId()`.** Add a small helper in `@careeros/tenancy`, `requireOrgId()`, that throws when there is no scope. Update every insert path into these tables, including imports, duplication, versions, slug redirects and statistics. `grep` for every `insert(schema.resume…)`.
5. **Public reads (D10 pattern).** Public resume pages, the public PDF, OpenGraph metadata in `apps/server/src/static/web.ts`, and statistics recorded from public views all run without a session.
   - Add `careeros_public_resume_org(username text, slug text) returns text`. It is `security definer` with `search_path` fixed to `pg_catalog, public`, owned by the owner role, with execute granted to `careeros_app`. It returns the org id only for a resume where `is_public` is true, or where it is password-protected under the existing access policy.
   - The public code paths call it, then run the existing logic inside `withOrgContext(orgId)`. Slug-redirect lookups use a matching function.
   - List every public path you touch.
6. **Flip `ORG_CONTEXT_REQUIRED` to `true`.** Update the shared test helpers. The api and server suites must still pass.
7. **Fix scope-outliving call sites** in the resume feature that are now reachable. This covers `public-pdf.ts:111`, the resume events generator and `recheckStaleDomains` if it touches these tables: await inside the scope, or open a new `withOrgContext` with the row's org.
8. **Register all five tables** in `packages/isolation-testing/src/registry.ts`, with API checks for the resume route group (P1-Q02).

## Tests

- **Migration test:**
  - On a DB seeded with 2 users and resumes, then migrated, every row has the right org.
  - Running it again changes nothing.
  - The down migration restores the previous state.
- **Isolation suite:** the DB and API checks pass for all five tables as `careeros_app`, and the coverage check is green.
- **e2e:** the existing resume specs pass, and so do the public resume page, the public PDF and statistics.
- **New integration test:** a public resume of org A resolves through the definer function, and a private one does not.
- **New integration test:** user B (org B) gets 404 for user A's resume id on every resume procedure.

## Acceptance

- All suites are green in CI with `ORG_CONTEXT_REQUIRED = true`.
- The definer functions are reviewed line by line in the PR description.
- Every upstream edit is marked `CAREEROS:` and listed in `docs/UPSTREAM_PATCHES.md`.
