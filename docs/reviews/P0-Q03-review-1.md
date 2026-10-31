# P0-Q03 review 1

**PR:** #11 · **Spec:** docs/plans/P0-Q03-e2e-tag-filter-flake.md · **Reviewer:** Opus (QA) · **Date:** 2026-10-31

## Verdict: Approved and merged (squash `c3c61cb`).

## Root cause (accepted)

`apps/web/src/libs/orpc/client.ts` uses `BatchLinkPlugin` for every call. Calls issued in the same tick are merged into one POST to `/api/rpc/__batch__`; a lone call keeps `/api/rpc/documents/page`. The test's route `**/api/rpc/documents/**` therefore missed the batched case, the request reached the real server, and the page showed "Nothing matches these filters" instead of the error alert. Timing decides batching, which explains the intermittent pattern (#9, #10 failed; others passed). Hypotheses (b) retry/backoff and (c) stale data were ruled out from code with line references. App behaviour is correct.

## Checks

| Item                                                 | Result                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Root cause stated with evidence                      | ✅ code-level, with file/line references in the PR                                               |
| Fix is test-side and minimal                         | ✅ route glob widened to `**/api/rpc/**`, still keyed on the body; one `// CAREEROS:` comment    |
| Assertion and timeout unchanged; no skip/retry/fixme | ✅                                                                                               |
| UPSTREAM_PATCHES row                                 | ✅                                                                                               |
| CI green on head `4ef32a9`                           | ✅ static, unit, e2e                                                                             |
| Repeat run (`--repeat-each=5`)                       | ⚠️ not run (no local e2e environment). Accepted: the mechanism is deterministic once understood. |

## Findings

- **Low** · tests/e2e/specs/library-pagination.spec.ts · When batched, the whole batch gets a 503, so co-batched calls also fail. If one of them ever renders a second `role="alert"`, the locator hits strict mode. · Keep on the STATUS watch list; if it appears, Opus specs a per-item batch response. No action now.
