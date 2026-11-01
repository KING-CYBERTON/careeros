# P1-Q08 review 1 (Opus, 2026-11-01)

Branch: fix/P1-Q08-shared-db-test-races (54ed4c850)
Verdict: approve, subject to fully green CI.

## Root causes (both verified by reproduction, and both differ from the spec's guess)

- **remaining-tenancy:** Postgres `now()` has microsecond precision, while the worker compares against JavaScript `new Date()`, which has millisecond precision. A row inserted in the same millisecond as the check counts as not yet due. The fix gives the test fixtures an explicit past due time, and the assertion is unchanged.
- **tenancy:** `release(error)` ends the client without waiting, so `pg_stat_activity` was read before the backend exited. The fix uses `vi.waitFor` (up to 5 s) with the same zero-length assertion.

## Also accepted

- `createIsolatedTestDatabase` in `@careeros/testing`, which drains backends instead of using FORCE so it never triggers 57P01. Nine suites now run on their own database, which also removes hazard 3 for them.

## Follow-ups

- **F1 (Q73, approved):** `runStorageCleanup` should compare `next_attempt_at` against the database `now()`, not JavaScript time, so a pass made immediately after a delete does not miss the job it just enqueued. Small production fix; spec P1-Q09.
- **F2 (hazard 3):** suites that replay migrations into a schema of the shared database rewrite the real `public` definer functions and their grants. P1-Q09 also moves the remaining schema-replay suites onto isolated databases. That covers agent-tenancy (make its db injectable) and the hand-built-schema suites, or else they should stop replaying function DDL.
