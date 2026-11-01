# P1-Q08: Remove shared-database races between integration test files

**Status:** Approved (Opus, 2026-11-01). **Thread:** 2 QA. **Branch:** `fix/P1-Q08-shared-db-test-races` (from develop)

## Problem

Develop has been red since #34 (runs 41307048405 and 41308795612), and PR runs pass or fail by chance.

- **Failure 1 (unit api shard).** `remaining-tenancy.integration.test.ts` > storage cleanup > "drains the queue across organizations…" fails with `expected "error" to be called at least once` (line 302).
  - Vitest runs 2 worker threads (`vitest.shared.mts:52-53`) against one shared `postgres` database.
  - `documents/service.integration.test.ts:143` runs `TRUNCATE released_username, storage_cleanup_job, "user" CASCADE`, and also calls `runStorageCleanup`. This can delete or drain the `bad-ok` row between its insert and the assertion.
- **Failure 2 (unit rest shard, seen on PR #37 run 41309320694).** `@careeros/tenancy` `src/tenancy.integration.test.ts` > "destroys a client whose context reset fails" fails with `expected [ { '?column?': 1 } ] to have a length of +0 but got 1`. It is probably the same class of problem (shared DB or pool state, or timing). Root-cause it from the test source and that job log (job 124856321175).

## Change

1. **Per-file isolation for DB-mutating integration tests.**
   - Every integration test file that TRUNCATEs, or runs a cross-org/global worker (storage cleanup, career jobs, purge, reaper), must run against its own database. Create it per file and drop it at the end, using the existing `@careeros/testing` helpers (`guardTestPool` and any create/drop-database helper). Add a small `createIsolatedTestDatabase()` helper there if none exists.
   - At minimum, convert `remaining-tenancy.integration.test.ts`, `documents/service.integration.test.ts` and any other file found by grepping for `TRUNCATE` or the global workers.
   - Migrate each database with the same migrations the suite uses today, and keep the role split: run the app role as `careeros_app` where the suite does.
2. **Failure 2.** Fix the real cause, whether that is pool sharing, timing or test order. Never loosen the assertion. If the test races a timer, make the code path deterministic (fake timers, or awaiting the destroy event).
3. **Prove it.**
   - Run each fixed file 20 times in a loop locally, alongside a concurrent run of its former racing partner.
   - Run the full api and tenancy suites twice.
   - Report the counts.
4. Make no change to vitest worker counts or CI sharding, and do not add retries.

## Acceptance

- careeros-ci is fully green on the PR.
- After merge, develop's push run is green.
- No test is skipped, loosened or retried.
