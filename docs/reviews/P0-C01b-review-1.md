# P0-C01b review 1

**PR:** #8 · **Spec:** docs/plans/cicd/P0-C01b-test-timeout.md (revision 2) · **Reviewer:** Opus · **Date:** 2026-10-31

## Verdict: Approved and merged (squash `7cac561`).

## History

- Revision 1 forwarded `--testTimeout=120000` through Turbo. CI showed the flag reached Vitest but the test still failed at 30000 ms: the file sets explicit `}, 30_000);` timeouts on its `beforeAll` and `it`, which override the CLI. Opus root-caused it from the log and the test source and revised the spec.
- Revision 2: two explicit timeouts raised to `120_000`, one `// CAREEROS:` comment, workflow reverted to `develop`, UPSTREAM_PATCHES row added.

## Checks

| Item                                                               | Result                                         |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| Diff matches spec exactly (two numbers, one comment, nothing else) | ✅                                             |
| `careeros-ci.yml` identical to `develop`                           | ✅                                             |
| UPSTREAM_PATCHES row present with drop condition                   | ✅ (table re-padded by oxfmt, whitespace only) |
| CI green on head `0f98681`, large-account test ran, not skipped    | ✅ static, unit, e2e                           |
| No skip, retry or quarantine                                       | ✅                                             |

## Findings

None.

## Note for QA (Thread 2)

PR #9 e2e failed once in `tests/e2e/specs/library-pagination.spec.ts:201` ("bounds tag filters … clears a first-load filter failure": alert not visible in 20 s). PR #9 touches no web code, and the same spec passed on #7 and #8. Watch for recurrence; if it fails again on an unrelated PR, Opus will write a spec to make the wait robust (no skip).
