# P3-T03 review 1

**Reviewer:** Opus, 2026-11-02 to 2026-11-08. **PR:** [#74](https://github.com/KING-CYBERTON/careeros/pull/74). **Verdict:** Approved after one round of changes. Merged on fully green CI, e2e included.

## Checked

- `@careeros/ai-metering` records every platform and server-managed AI call in `ai_usage` with its cost, against the organization's pooled credits. `AI_QUOTA_EXCEEDED` (402) at 100%, with the 80% warning in a header and in `ai/quota`.
- Prices checked against the current Claude price list: Sonnet 5.5 $2 / $10 (cache read $0.20), Haiku 5.5 $0.10 / $0.50, and $0.50 / $2.50 above 100K tokens.

## Changes requested (all fixed)

1. Cache writes are charged at 1.25 times the input rate.
2. Server-managed AI (`AI_PROVIDER` env) is metered as platform cost against the quota.
3. Voice requires the member's own provider, because voice calls cannot be metered.
4. Web and mobile read `ai/quota` after AI calls to show the 80% notice.
5. Questions renumbered to Q250 to Q259.
6. CI fixes: mobile store-review stub, P3-T01 down test reverts later migrations first, the cross-org inventory skip list, and the shared test entitlements stub now gives a real credit pool.

## Answers

Recorded in `docs/questions.md` (Q250 to Q259) by the coder. Note: a self-hosted server with only `AI_PROVIDER` set no longer offers voice; accepted for CareerOS.
