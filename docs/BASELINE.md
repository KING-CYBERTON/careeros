# CI baseline

Numbers later phases compare against, taken from one green `careeros-ci` run. Nothing was re-run locally (spec P0-T03, revision 2).

|                |                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Run            | [careeros-ci #18, run 41216741664](https://github.com/KING-CYBERTON/careeros/actions/runs/41216741664)                        |
| Event / branch | push / `develop`                                                                                                              |
| Commit         | `492283e2a17d04c77302d96d417a436b33eba3ed` (`docs: update status and add phase 0 reviews (#5)`)                               |
| Date           | 2026-10-31 (15:50 to 16:02 UTC)                                                                                               |
| Result         | success: `static`, `unit`, `e2e` all green                                                                                    |
| Runner         | `ubuntu-latest`: Ubuntu 24.04, image `ubuntu-24.04` version `20261025.353.1`, 4 vCPU (per spec; vCPU count is not in the log) |
| Node           | v24.22.1 (npm 11.19.1), from `.nvmrc` (24)                                                                                    |
| pnpm           | v12.16.1                                                                                                                      |
| turbo          | 2.11.10                                                                                                                       |
| Playwright     | @playwright/test 1.64.1                                                                                                       |
| Chromium       | Chrome for Testing 156.0.8078.4 (playwright chromium v1248)                                                                   |
| Postgres       | 16.15 (Debian 16.15-1.pgdg13+2), service container `postgres:16`                                                              |
| Workspace      | 25 workspace projects; typecheck covers 22 packages (mobile excluded)                                                         |

Commit `492283e` only adds docs on top of `7cac561` (P0-C01b); it is the latest green push run on `develop` at or after `7cac561` at the time of writing. It predates P0-T02 isolation package (#9), so `@careeros/isolation-testing` is not in these numbers.

## Jobs and commands

| Job    | Command                                                               | Result  | Counts                                        | Duration | Notes                                                                  |
| ------ | --------------------------------------------------------------------- | ------- | --------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| static | `pnpm install --frozen-lockfile`                                      | success | 1673 packages added                           | 9s       | "Done in 8.8s"                                                         |
| static | `pnpm lint` (`vp lint --deny-warnings`)                               | success | 0 warnings, 0 errors; 1726 files              | 3s       | tool time 2.2s, 174 rules                                              |
| static | `pnpm format:check` (`vp fmt --check`)                                | success | 2162 files correctly formatted                | 7s       | tool time 6.5s                                                         |
| static | `pnpm exec turbo boundaries`                                          | success | 1686 files in 24 packages, no issues          | 1s       |                                                                        |
| static | `pnpm exec turbo run typecheck --filter=!mobile`                      | success | 22 of 22 tasks successful, 0 cached           | 22s      | turbo time 22.578s; `tsrs --noEmit`                                    |
| static | job total                                                             | success |                                               | 1m 18s   | 15:50:20 to 15:51:38                                                   |
| unit   | `pnpm install --frozen-lockfile`                                      | success |                                               | 8s       |                                                                        |
| unit   | migrate test database, create and migrate OAuth test DB, create roles | success |                                               | 7s       | steps 9 to 11; exact commands not in log excerpt                       |
| unit   | `pnpm exec turbo run test:ci --concurrency=1 --filter=!mobile`        | success | 21 of 21 tasks successful, 0 cached; 0 failed | 8m 41s   | turbo time 8m41.148s. Counts for 12 packages below (2499 tests passed) |
| unit   | job total                                                             | success |                                               | 10m 4s   | 15:50:20 to 16:00:24                                                   |
| e2e    | `pnpm install --frozen-lockfile`                                      | success |                                               | 9s       |                                                                        |
| e2e    | `pnpm exec playwright install --with-deps chromium`                   | success | Chromium 156.0.8078.4                         | 34s      | step "Install Chromium and browser dependencies"                       |
| e2e    | `pnpm db:migrate`                                                     | success | 1 of 1 tasks successful                       | 4s       | turbo time 3.099s                                                      |
| e2e    | `pnpm build`                                                          | success | 3 of 3 tasks successful                       | 1m 10s   | turbo time 1m2.403s                                                    |
| e2e    | `pnpm exec playwright test --workers=1`                               | success | 60 passed, 0 failed, 0 skipped, 0 flaky       | 6m 36s   | Playwright reports 6.6m; 1 worker, project `chromium`                  |
| e2e    | job total                                                             | success |                                               | 9m 50s   | 15:51:41 to 16:01:31                                                   |

Step durations come from job step timestamps. "Tool time" is the figure printed by the tool itself.

## Unit tests per package

Command: `vp test run ... --passWithNoTests` through `test:ci`, one package at a time (`--concurrency=1`). Skipped tests: none reported in any listed package.

| Package                      | Test files | Tests passed | Failed     | Skipped    | Duration (vitest) |
| ---------------------------- | ---------- | ------------ | ---------- | ---------- | ----------------- |
| `@reactive-resume/pdf`       | 70         | 457          | 0          | 0          | 102.00s           |
| `@reactive-resume/odt`       | 1          | 22           | 0          | 0          | 758ms             |
| `@reactive-resume/env`       | 2          | 52           | 0          | 0          | 884ms             |
| `@reactive-resume/tooling`   | 10         | 83           | 0          | 0          | 13.00s            |
| `@reactive-resume/db`        | 3          | 4            | 0          | 0          | 3.23s             |
| `@reactive-resume/email`     | 1          | 3            | 0          | 0          | 697ms             |
| `@reactive-resume/auth`      | 9          | 56           | 0          | 0          | 12.91s            |
| `@reactive-resume/api`       | 89         | 1056         | 0          | 0          | 127.33s           |
| `web`                        | 102        | 531          | 0          | 0          | 158.71s           |
| `@reactive-resume/mcp`       | 5          | 24           | 0          | 0          | 15.72s            |
| `dsh-plugin-reactive-resume` | 3          | 6            | 0          | 0          | 1.07s             |
| `server`                     | 27         | 205          | 0          | 0          | 28.40s            |
| **Subtotal (12 packages)**   | **322**    | **2499**     | **0**      | **0**      |                   |
| `@careeros/testing`          | not in log | not in log   | not in log | not in log | not in log        |
| `@reactive-resume/ai`        | not in log | not in log   | not in log | not in log | not in log        |
| `@reactive-resume/docx`      | not in log | not in log   | not in log | not in log | not in log        |
| `@reactive-resume/fonts`     | not in log | not in log   | not in log | not in log | not in log        |
| `@reactive-resume/import`    | not in log | not in log   | not in log | not in log | not in log        |
| `@reactive-resume/resume`    | not in log | not in log   | not in log | not in log | not in log        |
| `@reactive-resume/schema`    | not in log | not in log   | not in log | not in log | not in log        |
| `@reactive-resume/ui`        | not in log | not in log   | not in log | not in log | not in log        |
| `@reactive-resume/utils`     | not in log | not in log   | not in log | not in log | not in log        |

The GitHub job-log API returns only the last 5,426 lines of the `unit` job (about 689,000 characters); the output of the first nine `test:ci` tasks falls before that window, and the log archive download is not reachable from the agent sandbox. Turbo reports all 21 tasks successful, so those nine packages passed, but their counts are not recorded here. There is no run-wide test total in the log. The 12-package subtotal is the sum of the rows above (the nine packages are named by elimination: the 21 packages with a `test:ci` script minus the 12 listed).

## Known environment notes

a. **P0-C01b timeout patch.** Standard 4-vCPU runners exceed the 30s default on the large-account listing test, so P0-C01b (`7cac561`) raises the explicit timeouts for that test. This run includes the patch.

b. **Runner size.** Upstream CI runs on 32-vCPU Blacksmith runners (four packages concurrently, two Vitest workers each). CareerOS CI uses `ubuntu-latest` (4 vCPU) with `--concurrency=1`. Durations here are not comparable to upstream figures.

c. **Watch-list entry.** `tests/e2e/specs/library-pagination.spec.ts:201` ("bounds tag filters from chips and URLs and clears a first-load filter failure") is on the STATUS.md watch list as timing-sensitive. It passed in this run in 16.4s (test 46 of 60).

Other observations: the e2e log contains `[WebServer]` stack traces and a `WebAccessError ... (unsafe-url)` message while the tests that exercise those failure paths ran; all 60 tests still passed. The `unit` and `e2e` jobs also print `No locally installed turbo found` warnings (global turbo 2.11.10 is used for `test:ci`).
