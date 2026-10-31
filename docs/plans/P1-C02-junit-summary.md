# P1-C02: Per-package test summary in CI

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 3 CI/CD · **Phase plan:** [P1-PHASE-PLAN.md](P1-PHASE-PLAN.md) · **Depends on:** none

## Goal

Each package's test counts should be visible in the CI run summary, without reading log tails. P0-T03 could not record counts for 9 packages because the job-log API only returns the tail.

## Scope

1. In `.github/workflows/careeros-ci.yml`, after the unit step, add a `Test summary` step with `if: always()`.
   - It reads every `packages/*/reports/**/*.xml` and `apps/*/reports/**/*.xml` JUnit file that `test:ci` writes.
   - It appends a Markdown table to `$GITHUB_STEP_SUMMARY` with the columns package, tests, passed, failed, skipped and time, plus a total row.
   - Put the script in `tooling/ci/junit-summary.mjs`, using Node built-ins only, with no new dependency. Parse the attributes of `<testsuites>`, or of `<testsuite>` when there is no `<testsuites>`, with a small, tested parser.
   - A package that has a `test:ci` script but no report shows `no report`.
2. Upload the reports as an artifact named `unit-junit`, kept for 14 days, with `if: always()`.
3. Add a unit test for the parser in `tooling/ci/junit-summary.test.mjs`, or wherever the repo's tooling tests live. Cover a normal file, a file with failures and skips, a malformed file (reported as an error row, not a crash), and an empty directory.
4. Refresh `docs/BASELINE.md` from the first green run on `develop` after merge. Opus does this in a docs sync, not this task.

## Acceptance

- In the PR's own CI run, the summary page shows one row per package with non-zero counts, including the 9 packages that had none before.
- The step never turns a green unit job red. If the script itself fails, it logs and exits 0, but the parser test must pass.
- Pin actions by SHA, as in the rest of the workflow.
- The lint and fmt checks on the changed paths are clean.
