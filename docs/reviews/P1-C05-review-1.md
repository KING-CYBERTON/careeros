# P1-C05 CI speed: Opus review 1

**Branch:** `feature/P1-C05-ci-speed` @ `016bba09f` · **Spec:** [plans/P1-C05-ci-speed.md](../plans/P1-C05-ci-speed.md) · **Verdict:** Approved after four CI-driven revisions. Merged as #25 (`4b86609`).

## What CI taught us

1. **Parallel turbo tasks on one runner do not work.** `--concurrency=3` and then `2` each made a different cold-import test time out: auth `config-lifecycle` (5s), pdf `long-list-pagination` (30s), server `app.test.ts` (15s) and a web documents test (5s). The fix was to shard the unit job across three runners (`pdf`, `api`, `rest`), each running serially, with an aggregate `unit` check. Measured shard times were 1.5, 4.3 and 5.6 minutes.
2. **e2e workers.** One worker took 5m45s and three took 5m41s, and three caused an `application-lanes` timeout. The single server process is the bottleneck, so CI stays at one worker (Q24).
3. **apt hang.** On develop the PDF tools install hung for 29 minutes. It now has `timeout-minutes: 5` and retries.
4. **Docs-only fast path never fired.** The `changes` job fetched the base commit after checkout without credentials and fell back to full checks every time. It now checks out with `fetch-depth: 0` and keeps `persist-credentials: false`. This has not yet been seen working in real CI; the next docs-only PR confirms it.
5. **Auth DB suites (Q22).** Enabling them exposed a teardown race: the forced `DROP DATABASE` sent 57P01 to a closing pg client with no `'error'` listener. `guardTestPool` now ignores 57P01 during teardown only.

## Notes

- The 100 ms wait in `guardTestPool.close()` is a pragmatic margin, not a guarantee. The error listener is the real fix.
- The `packages/db` suites create pools the same way. Watch for the same 57P01 there.
- Commit `578becd` carries AI trailers. The squash merge message has none.
