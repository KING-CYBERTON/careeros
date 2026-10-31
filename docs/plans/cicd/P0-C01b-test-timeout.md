# P0-C01b — Unit-test timeout on standard GitHub runners

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 3 CI/CD · **Depends on:** P0-C01 (merged)

## Problem

The upstream test `packages/api/src/features/documents/listing.integration.test.ts > document SQL pages on a large account > keeps 19.5k live and 19.5k Trash rows…` hit Vitest's default 30 s timeout on three unrelated PRs (#4, #5 docs-only, #7). It passed on the P0-C01 run. Upstream normally runs CI on 32-vCPU Blacksmith runners. We run on 4-vCPU `ubuntu-latest`, where that file takes about 31 s. It is an environment-speed problem, not a correctness failure: the other 1055 tests pass.

## Decision

Raise the Vitest per-test timeout **in CI only**, from the workflow, without editing any upstream test or config. Do not skip, retry or quarantine the test.

## Change

In `.github/workflows/careeros-ci.yml`, job `unit`, step "Run unit tests (mobile excluded)": forward `--testTimeout=120000` to every package's `test:ci` script through Turbo's argument pass-through (`turbo run test:ci … -- --testTimeout=120000`). All workspace `test:ci` scripts are `vp test run …`, so the flag reaches Vitest. Add a `# CAREEROS:` comment above the step explaining why (runner speed vs upstream's Blacksmith runners).

## Acceptance

- `careeros-ci` green on the PR, with the large-account test passing (not skipped).
- No upstream file changed.
