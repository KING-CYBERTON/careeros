# P1-Q04 Deadlock in integration-test cleanup: Opus review 1

**Verdict:** Approved. Merge after green careeros-ci.

- `deleteAllUsers` deletes row by row in a fixed `lower(username), id` order inside one transaction. Every concurrent cleanup therefore takes the `lock_username_claim` advisory locks in the same sequence. That fixes the root cause, and the bounded 40P01 retry is a safety net. Deleting row by row is the right call, because `delete … where id in (ordered subquery)` does not guarantee lock order.
- The old unordered delete deadlocked in 5 of 5 local runs. The new regression test passed 5 runs in a row.
- **Q19:** only lanes does a bulk row delete. The career and documents tests use `TRUNCATE … CASCADE`, which fires no row triggers. The spec's three-file list was wrong, and leaving those two files alone is correct.
- `role-recipient.integration.test.ts` fails locally on the base branch as well. It passes in CI (develop run 41236851721 had only the lanes failure), so it is a sandbox environment difference and out of scope. CI is the gate.
