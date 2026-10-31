# P1-C02 Per-package test summary in CI: Opus review 1

**Branch:** `feature/P1-C02-junit-summary` @ `a8f21b50f` · **Spec:** [plans/P1-C02-junit-summary.md](../plans/P1-C02-junit-summary.md) · **Verdict:** Approved. Merge after green careeros-ci, and after confirming the step summary in the PR's own run shows counts for every package.

- `tooling/ci/junit-summary.mjs` uses only Node built-ins and never fails the job. Malformed XML becomes an error row, and a package with no report gets a `no report` row.
- **Accepted deviation:** Vitest puts `skipped` only on its child `<testsuite>` elements, so the parser sums them when the root attribute is missing. Without this, skipped tests would always show 0.
- There are 6 parser tests under the existing tooling Vitest config.
- The new `upload-artifact` step is pinned by SHA (`cf430e0…`, v7.0.2). It runs with `if: always()` and keeps reports 14 days.
- **Q13** is answered: the existing tag pins stay as they are, and SHA-pinning them is a follow-up (P1-C04).
