# P1-Q06 Widen the timing margin in the 2FA deadline integration test

**Thread:** 2 — QA · **Status:** Approved (Opus, 2026-11-01) · **Branch:** `fix/P1-Q06-2fa-deadline-margin`

## Problem

`packages/api/src/features/auth/account.integration.test.ts` › "hands guest work to the challenge accepted at its deadline, only once, and only for that account" (an upstream test) sets the challenge to expire `now() + 300 ms` and expects `two-factor/verify-totp` to accept it before then. A `pg_sleep(0.6)` trigger on `session` inserts makes the deadline pass while the session row is written. On a loaded CI runner, the request itself can take more than 300 ms before the challenge is checked. The endpoint then answers 401 `INVALID_TWO_FACTOR_COOKIE` (PR #27, unit (api), first attempt; it passed on re-run).

That failure also skipped the file's cleanup, so the next test, "confines concurrent account calls to their authenticated users", found 3 session rows instead of 1.

## Change

1. Keep the test's meaning (the deadline passes after acceptance, during the session write) and widen the margins: expire at `now() + interval '2 seconds'` and sleep `pg_sleep(3)` in the trigger. If the three iterations make the test too slow, reduce the loop to two iterations and say so in the report.
2. Make cleanup robust. Session cleanup that a later test depends on must run even when an assertion fails, using `try/finally` or the file's `afterEach`. Do this for the session table only, and do not change what any test asserts.
3. Mark the edits with `// CAREEROS:` and add a row to `docs/UPSTREAM_PATCHES.md` under P1-Q06.

## Acceptance

- Both tests pass locally against Postgres 16 with the CI unit env, 3 runs in a row.
- No assertion is removed or weakened.
- Lint and format checks are clean on the changed files.
