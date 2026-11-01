# P1-Q04: Deadlock in integration-test cleanup

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 2 QA · **Depends on:** none

## Problem

In the develop CI run 41236851721, the unit job failed in `packages/api/src/features/applications/lanes.integration.test.ts`. The `beforeEach` (`await getDb().delete(tables.user)`) hit `40P01 deadlock detected`. The upstream trigger `lock_username_claim()` takes `pg_advisory_xact_lock(hashtextextended('username:' || name))` once per deleted row. That trigger was added in migration `20261028045128_serialize_username_reservations`.

When two api test files run at the same time against one database, each does a bulk `delete from "user"` over the same fixture usernames. They take these advisory locks in different row orders, and that deadlocks. Separate schemas don't help, because advisory locks are database-wide. Three files do this bulk delete: lanes, career/service and documents/service.

PostgreSQL treats deadlocks as a normal, retryable outcome. So the fix is a deterministic delete order, with a bounded retry as a safety net. Do not skip or serialize the tests.

## Scope

All changes are in test code only. Never touch the upstream trigger or the migration.

1. Add a test helper, `deleteAllUsers(db, userTable)`, in a shared api test-support location. Look for an existing `test-utils` or `testing` folder in `packages/api/src`. If there is none, create `packages/api/src/test-support/delete-users.ts`.
   - Delete in **one deterministic order**: `delete from "user" where id in (select id from "user" order by username, id)`. Or select the ids ordered and delete in that order inside one statement. Every concurrent cleanup then takes its locks in the same sequence.
   - Wrap it in a retry: at most 3 attempts on SQLSTATE `40P01` only, with a 20 to 80 ms jittered backoff. Rethrow anything else immediately.
2. Use the helper in the three files above. Each upstream test file edit gets a `CAREEROS:` comment and an UPSTREAM_PATCHES row.
3. Add a regression test, `delete-users.integration.test.ts`. Two connections each seed the same 50 usernames in their own schema, then run `deleteAllUsers` at the same time, 20 rounds. Assert there is no error.
   - Before the fix, run the same race with the old unordered delete, show it can deadlock (a short loop is enough), and record the result in the PR body.
   - Don't commit a test that relies on reproducing the deadlock.

## Acceptance

- The new test passes 5 runs in a row locally.
- `pnpm --filter @reactive-resume/api test` passes.
- lint, fmt and tsc are clean.
