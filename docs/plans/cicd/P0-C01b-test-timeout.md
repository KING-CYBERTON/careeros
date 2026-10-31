# P0-C01b — Unit-test timeout on standard GitHub runners

**Status:** Approved, revision 2 (Opus, 2026-10-31) · **Thread:** 3 CI/CD · **Depends on:** P0-C01 (merged)

## Problem

The upstream test `packages/api/src/features/documents/listing.integration.test.ts > document SQL pages on a large account > keeps 19.5k live and 19.5k Trash rows…` hits a 30 s timeout on most PRs (#4, #5 docs-only, #7, #8, #9). Upstream runs CI on 32-vCPU Blacksmith runners; we run on 4-vCPU `ubuntu-latest`, where the test takes just over 30 s. It is an environment-speed problem, not a correctness failure: the other 1055 tests pass.

## Why revision 1 did not work

Revision 1 passed `--testTimeout=120000` through Turbo. The flag reached Vitest (visible in the PR #8 log), but the test still timed out at 30000 ms because the file sets **explicit per-hook and per-test timeouts** (`}, 30_000);` on the `beforeAll` at line 61 and on the `it` at line 167). Explicit per-test values override the CLI setting.

## Decision (revision 2)

Make the smallest upstream edit: raise those two explicit timeouts in that one test file. Do not skip, retry or quarantine the test. Do not move CI to paid larger runners (E3).

## Change

1. `packages/api/src/features/documents/listing.integration.test.ts`: change both `30_000` timeout arguments (lines 61 and 167) to `120_000`. Add one `// CAREEROS:` comment above the `beforeAll` explaining the reason (4-vCPU GitHub runners vs upstream's 32-vCPU Blacksmith runners; see this spec). Change nothing else in the file.
2. `.github/workflows/careeros-ci.yml`: revert revision 1. Remove `-- --testTimeout=120000` and the `# CAREEROS:` comment added for it, so the step matches `develop` again.
3. `docs/UPSTREAM_PATCHES.md`: add a row for the test file (task P0-C01b, reason as above, "drop when upstream raises the timeout or we move to faster runners").

## Acceptance

- `careeros-ci` green on the PR, with the large-account test passing (not skipped).
- The only upstream file changed is `listing.integration.test.ts`, with exactly the two timeout values and one comment; it is listed in `docs/UPSTREAM_PATCHES.md`.
