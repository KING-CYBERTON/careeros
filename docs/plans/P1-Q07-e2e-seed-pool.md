# P1-Q07: E2E raw seeding must bypass RLS through the owner role

Status: Approved (Opus, 2026-11-01)
Branch: fix/P1-Q07-e2e-seed-pool (from develop)

## Problem

Since P1-T05 (#30), develop's e2e job fails deterministically. Three tests in
`tests/e2e/specs/library-pagination.spec.ts` (:27, :148, :201) throw "Missing fictional letter owner".
The spec opens `new Pool({ connectionString: process.env.DATABASE_URL })`. In CI, DATABASE_URL is
`careeros_app`. With no `app.current_org_id` set, the `tenant_isolation` policy on `cover_letter` hides every row.
The bulk insert also omits `organization_id`, which is now NOT NULL. Runs: 41286285202 (PR) and 41287008321 (develop).

## Change

1. New fixture `tests/e2e/fixtures/seed-db.ts` (CareerOS file, no upstream marker needed):
   - `getSeedDatabaseUrl()` returns `E2E_SEED_DATABASE_URL ?? DATABASE_MIGRATION_URL ?? DATABASE_URL`.
   - Falling back to DATABASE_URL keeps local single-role setups working.
   - `withSeedPool(run)` opens a pool, runs the callback and always calls `end()`. Same shape as `withPool` in careeros-org.ts.
   - A header comment says this is test-only and relies on the owner role's `owner_access` policy.
2. `library-pagination.spec.ts` (upstream file, so add CAREEROS: markers and an UPSTREAM_PATCHES row):
   - Every raw query (select, insert, update and the count/trashed polling) uses the seed pool.
   - The bulk insert copies `organization_id` from the source row.
   - Keep the test logic otherwise unchanged.
3. Audit `ai-reports.spec.ts` and `discovery.spec.ts`:
   - If either reads or writes a table that has RLS today, or will get RLS in P1-T06 to T09, switch it to the seed pool. T06 covers application*; T07 career and scheduler; T08 agent and AI; T09 custom_domain, storage_cleanup_job and web_access_credentials.
   - Do the same for any tenant-data insert that lacks `organization_id`.
   - Leave `fixtures/db.ts` and `careeros-org.ts` on DATABASE_URL. They only touch user, organization and member, which have no RLS.
4. `.github/workflows/careeros-ci.yml`, e2e job env: no change is needed, since DATABASE_MIGRATION_URL is already set. Mention the new variable in `tests/e2e/README.md`.
5. docs/questions.md: log any open point.

## Acceptance

- careeros-ci e2e is fully green (62/62) on the PR.
- Lint and format checks are clean on the changed paths.
- No test is skipped or loosened.
- Commit messages follow Conventional Commits, with no AI attribution and no Co-Authored-By trailers.
