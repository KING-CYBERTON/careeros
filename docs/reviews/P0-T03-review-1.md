# P0-T03 review 1

**PR:** #12 · **Spec:** docs/plans/P0-T03-local-baseline.md (revision 2, baseline from CI) · **Reviewer:** Opus · **Date:** 2026-10-31

## Verdict: Approved, merge after green careeros-ci.

## Checks (test plan P0-T03 rev 2)

| #   | Item                                                           | Result                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Names one green run at or after `7cac561`                      | ✅ run 41216741664 (push, `492283e`)                                                                                                                                                                                             |
| 2   | Every command in static, unit, e2e with result/counts/duration | ✅                                                                                                                                                                                                                               |
| 3   | Per-package counts sum to totals                               | ⚠️ 12 of 21 packages have counts (2499 passed, 0 failed); 9 show "not in log" because the job-log API returns only the tail of the unit log and the full download is blocked by the proxy. Turbo reports 21/21 tasks successful. |
| 4   | Versions                                                       | ✅ Node 24.22.1, pnpm 12.16.1, turbo 2.11.10, Playwright 1.64.1, Chromium 156, Postgres 16.15, ubuntu-24.04                                                                                                                      |
| 5   | Environment notes                                              | ✅                                                                                                                                                                                                                               |
| 6   | Only BASELINE.md changed                                       | ✅                                                                                                                                                                                                                               |

## Findings

- **Low** · docs/BASELINE.md · Nine packages lack test counts, and the run predates `@careeros/isolation-testing` (#9). · Accepted for Phase 0. Phase 1 plan will add a CI step that prints a one-line per-package summary from the JUnit reports (`reports/`) so the baseline can be refreshed completely at the Phase 1 exit.
