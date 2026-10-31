# P0-T03 — Baseline from CI

**Status:** Approved, revision 2 (Opus, 2026-10-31) · **Thread:** 1 Build · **Depends on:** P0-T01, P0-C01, P0-C01b · **Test plan:** [../test-plans/P0-T03.md](../test-plans/P0-T03.md)

## Why revision 2

Revision 1 asked for a local run with Docker. The agent sandbox has no Docker daemon and cannot execute the `turbo` and `tsrs` binaries, so a local baseline would be incomplete. `careeros-ci` already runs every baseline command on a clean Linux x64 runner, which is also the environment later phases compare against. The baseline is therefore taken from CI.

## Goal

Record the numbers later phases compare against: test counts, durations and versions for the unmodified upstream app plus the Phase 0 CareerOS scaffolding.

## Steps

1. Pick the latest **green** `careeros-ci` run on `develop` (push event) after P0-C01b was merged (`7cac561`). If none exists, use the latest green run on a PR whose base is that commit.
2. From that run's job logs (`static`, `unit`, `e2e`), extract per command: result, tests passed/failed/skipped (per package for `unit`), and duration. Use the GitHub API or MCP job-log tools; do not re-run CI to collect numbers.
3. Record Node, pnpm, Postgres and Playwright/Chromium versions from the logs, the runner image and size (`ubuntu-latest`, 4 vCPU), the run URL and the commit SHA.
4. Write `docs/BASELINE.md` with: a header (run URL, commit, date, versions); a table `job · command · result · counts · duration · notes`; a per-package unit table; a "known environment notes" section listing (a) P0-C01b timeout patch, (b) upstream CI runs on 32-vCPU Blacksmith runners, so durations are not comparable to upstream, (c) the `library-pagination.spec.ts:201` watch-list entry from STATUS.md.
5. `/api/health` is not part of this task (it is covered by P0-C02 and P0-C03).

## Out of scope

Fixing any upstream failure, running anything locally, changing workflows.

## Acceptance criteria

- `docs/BASELINE.md` exists with real numbers from one named, green CI run, every command in `static`, `unit` and `e2e`, and the versions above.
- No other files changed.
- PR `[P0-T03] CI baseline` targets `develop`.
