# P1-Q01 Tenancy tests under RLS and load: Opus review 1

**Branch:** `feature/P1-Q01-tenancy-tests` @ `7144a50ed` · **Spec:** [plans/P1-Q01-tenancy-tests.md](../plans/P1-Q01-tenancy-tests.md) · **Verdict:** Approved. Merge after green careeros-ci.

The change is test-only: one new integration test file and a README. No production code changed.

- **Fixture:** the probe table uses forced RLS and the D4 policy. It lives in an isolated schema, so parallel files don't collide, and it is dropped afterwards. The test asserts `careeros_app`, `rolsuper=false` and `rolbypassrls=false`, rather than assuming them.
- **RLS:** `getPool()`, `db.execute` and `db.transaction` each see only their own org. An insert for another org is rejected with 42501. Outside any scope, reads return 0 rows and inserts fail. After a scope ends, a later checkout carries no org setting.
- **Load:** 300 interleaved calls on a pool of 5 use a seeded plan. Every read, before and after the delay, sees only its own org. `totalCount` never exceeded 5. The run took 614 ms, and the test passed 5 runs in a row.
- **Error path:** 13% of calls throw. The surviving calls are correct, the pool recovers, and the next checkout is clean.

A peak `waitingCount` of 299 is expected with every call issued at once, and it shows the pool queues rather than over-allocating. No findings.
