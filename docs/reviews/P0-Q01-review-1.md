# P0-Q01 — Review 1

**PR:** https://github.com/KING-CYBERTON/careeros/pull/4 · **Commit:** `0b3ac7d` · **Reviewer:** Opus (Thread 2) · **Date:** 2026-10-31

## Test plan

| Row         | Result       | Notes                                                                                                                                                                     |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–7         | Pass (local) | 14 tests, 100% line coverage on `src/`, local Postgres 16                                                                                                                 |
| 8 Smoke e2e | Pass (local) | Ran with a temporary Playwright config outside the repo; upstream config untouched                                                                                        |
| 9 Static    | Partial      | lint, boundaries and fmt pass. `tsrs` and `turbo run` can't execute in the sandbox (Exec format error, upstream packages too). **CI must confirm typecheck and test:ci.** |

## PRODUCT.md §1.6 checklist

Tenancy: n/a (no tenant tables yet; the helpers set org context transaction-locally via `set_config(..., true)` as specified). No secrets: CI/local fixture values are documented as disposable. Upstream edits are minimal and logged (`.env.example`, lockfile).

## Findings

| Severity | File:Line                                                    | Issue                                                                                                            | Impact                                        | Fix instruction for Sonnet                                                                                                 |
| -------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Low      | `packages/careeros-testing/src/db.ts` (withOrgContext catch) | If `ROLLBACK` itself throws (for example a dropped connection), its error replaces the callback's original error | Harder debugging of test failures             | Next time this file is touched (P0-Q02), wrap the ROLLBACK so the original error is always the one rethrown. Not blocking. |
| Low      | `.env.example` (appended block)                              | Upstream `compose.yml` loads `.env.example` as an env file, so these test-only vars reach the app container      | None functionally, since the app ignores them | Accept. Keep the "tests only" comment. Staging uses its own `.env.staging.example` (P0-C03).                               |

Open question 1 (CI path `packages/testing` vs `packages/careeros-testing`): answered by Opus. P0-C01 is fixed to check `packages/careeros-testing`. The package stays where the spec puts it.
Open question 2 (uuid vs text): answered. Text, per inventory F1. `CODING-STANDARDS.md` §3 corrected.

## Verdict

**Approved, merge after green CI.** Merge only after P0-C01 is on `develop` and `careeros-ci` passes on this PR (merge `develop` into the branch to trigger it).
