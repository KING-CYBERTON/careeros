# P3-T11 review 1: OpenRouter as the platform AI provider

**Reviewer:** Opus, 2026-11-11. **Commit:** `75286ccff`. **Spec:** [P3-T11](../plans/P3-T11-openrouter-platform-ai.md). **Verdict:** Pass, no Critical or High findings.

| Severity | File:Line                                                   | Issue                                                                                          | Impact                          | Fix instruction                                 |
| -------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------- |
| Low      | `packages/api/src/features/ai/service.ts` (`metered` JSDoc) | The comment is one line over 120 columns.                                                      | Readability only.               | Wrap the comment at the next edit of this file. |
| Info     | `docs/questions.md` Q560                                    | Guard test lives in `call-sites.test.ts`; OpenRouter docs went to `environment-variables.mdx`. | None. Both are the better home. | Accepted (answer Q560).                         |

Checked: D1 key selection has no fallback; D2 unmapped ids fail closed; D3 alias pricing keeps `ai_usage.model` as the wire id; D4 guard no longer depends on the provider name; D5 prompt caching stays gated on `anthropic`. Unit suites for ai-metering, env and the api AI features pass; typecheck, lint, format, boundaries and the branding gate pass.
