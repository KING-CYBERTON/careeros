# P1-Q01: Tenancy tests under RLS and load

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 2 QA · **Phase plan:** [P1-PHASE-PLAN.md](P1-PHASE-PLAN.md) (D3, D4) · **Depends on:** P1-T02 (merged in #19)

## Goal

P1-T02 already unit-tests `withOrgContext`. This task proves the two things those tests cannot: that a real RLS policy under `careeros_app` sees exactly the org of the scope, and that heavy interleaved traffic never mixes orgs or exhausts the pool. No feature table has RLS until P1-T04, so the tests create a temporary fixture table.

## Scope

All work goes in `packages/tenancy/src/` as integration tests (`*.integration.test.ts`), plus a helper in `@careeros/testing` if one is needed. Change no production code. If a test exposes a bug, write it up in `docs/questions.md` and leave the failing test out of the commit. Never skip a test to get green.

1. **Fixture.**
   - As the owner role, create a table `careeros_tenancy_probe(id text primary key, organization_id text not null, payload text)`.
   - Enable and **force** RLS on it, using the D4 policy: `organization_id = current_setting('app.current_org_id', true)` for both using and with check.
   - Grant select, insert, update and delete to `careeros_app`.
   - Drop the table after the suite.
   - The test process connects as `careeros_app` (NOSUPERUSER, NOBYPASSRLS). Assert that at the start.
2. **RLS through the scope.**
   - Inside `withOrgContext("org_a")`, `db` and `getPool()` see only org A's rows.
   - Inserting a row with `organization_id = 'org_b'` fails with an RLS violation.
   - Outside any scope, a select returns 0 rows and an insert fails. This is fail closed.
   - After a scope ends, the next checkout from the pool (outside any scope) sees no org setting: `current_setting('app.current_org_id', true)` is empty or null.
3. **Interleaved load.**
   - Use 3 orgs with 20 rows each and a pool `max` of 5.
   - Run 300 concurrent `withOrgContext` calls with orgs in random order. Each call awaits a random 0 to 15 ms delay between two queries, and some use `db.transaction`.
   - Assert that every call sees only its own org's 20 rows, both before and after the delay.
   - Assert there are no errors, and that pool `totalCount` never exceeds `max`. Record the peak `waitingCount`.
   - Make the run deterministic enough to pass 5 times in a row. Use a seeded random source.
4. **Error path under load.** About 10% of the calls in item 3 throw inside `fn` at a random point. Afterwards:
   - Every surviving call is still correct.
   - The pool recovers: a further 50 calls succeed.
   - Destroyed clients are replaced: `totalCount` stays at or below `max`.
5. **Report.** Append a short "P1-Q01 results" section to `packages/tenancy/README.md`, creating the file if needed. Give the peak waiting count, the wall time of the 300-call run, and the pass streak.

## Acceptance

- `pnpm --filter @careeros/tenancy test` passes locally 5 times in a row and in CI.
- The tests run as `careeros_app`, and that is asserted, not assumed.
- No production files change.
- The lint, fmt and tsc checks on `packages/tenancy` are clean.
