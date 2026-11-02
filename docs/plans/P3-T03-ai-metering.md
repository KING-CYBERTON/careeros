# P3-T03: Platform Claude provider, AI usage metering and quotas

**Status:** Approved (Opus, 2026-11-02). **Thread:** 1 Build. **Phase plan:** [P3-PHASE-PLAN.md](P3-PHASE-PLAN.md), decision D5. **Depends on:** P3-T01 merged.
**Branch:** `feat/P3-T03-ai-metering`. **Questions:** start at Q200.

## Goal

Today every AI call uses a provider key a member saved (`ai_provider`). Add a platform-provided Claude option that orgs get through their plan. Meter every platform call into `ai_usage`, and enforce the org's pooled monthly credits. Members' own keys keep working and are never charged against the quota.

## Requirements

1. **Package `packages/ai-metering` (`@careeros/ai-metering`)** (PRODUCT.md §5.2). Turbo tags: `runtime:server`, `role:domain`. It holds the price table, the credit maths, the usage recorder and the quota check.
2. **Schema:** `ai_usage` in `packages/db/src/schema/ai-usage.ts`:
   - `id` uuidv7 PK.
   - `organization_id`: not null, FK, CASCADE.
   - `user_id`: FK to user, SET NULL.
   - `source`: text, CHECK in (`platform`, `own_key`).
   - `feature`: text, not null. A short key such as `resume.improve`, `cover_letter.draft`, `agent.turn`, `ats.review`, `career.generate` or `applications.ai`. List them all as a const in the package.
   - `provider` and `model`: text, not null.
   - `input_tokens`, `output_tokens`, `cached_input_tokens`: integers, not null, default 0.
   - `cost_usd_micros`: bigint, not null, default 0.
   - `credits`: integer, not null, default 0.
   - `created_at`.
   - Index on (`organization_id`, `created_at`).
   - Migration with ENABLE and FORCE RLS and `tenant_isolation`. `careeros_app` gets SELECT and INSERT, and no UPDATE or DELETE. Register it in the isolation registry. Ship a `down.sql`.
3. **Platform provider:**
   - New env `ANTHROPIC_API_KEY`: optional, server only. Wire it in `packages/env/src/server.ts`, `.env.example` (placeholder only), `turbo.json` `globalPassThroughEnv`, and the staging `.env.staging.example`.
   - New env `CAREEROS_AI_MODEL_GENERATION`, default `claude-sonnet-4-5`, and `CAREEROS_AI_MODEL_FAST`, default `claude-haiku-4-5`. Check the current model ids against the Claude API docs; if these are out of date, use the current Sonnet and Haiku ids and say so in the PR.
   - Where the app picks a member's provider today, add a fallback: if the member has no enabled provider of their own, the org's entitlements include `platform_ai`, and `ANTHROPIC_API_KEY` is set, use the platform key with the generation model, or the fast model for features marked "fast" in the feature list.
   - Find the single place the provider row is resolved for each feature. If there is no single place, add one in `packages/api/src/features/ai/` and route every call site through it. The call sites found so far are `ai/improve.ts`, `ai/service.ts` (three), `ai/ats-review.ts`, `agent/service.ts`, `career/role-suggestions.ts`, `career/generate.ts`, `cover-letters/draft.ts` and `applications/ai.ts` (two). Confirm the full list with a grep in the PR.
   - The platform key never leaves the server: never returned by an API, never logged, never stored in `ai_provider`.
   - The UI already shows the member's providers. Add one read-only "Included with your plan" entry when platform AI applies, through the existing providers list procedure, with no key preview.
4. **Metering:**
   - Wrap the language model returned by `getModel` and `getAgentModel` with AI SDK middleware (`wrapLanguageModel`) that records usage after both generate and stream. For streams, record when the stream finishes, including when it is aborted after tokens were produced, using whatever usage the SDK reports.
   - Every recorded call writes one `ai_usage` row with `source = platform` or `own_key`. Own-key rows have cost 0 and credits 0.
   - Price table in code: USD per million input, output and cached tokens, per model id, for the two default models. The source and date are noted in a comment. An unknown model on the platform key fails closed: the call is refused, not recorded at zero.
   - Credits: 1 credit = USD 0.01 of platform cost, rounded up per call. Put this rule in one function.
   - Writes run inside the caller's org context, so RLS applies.
   - A failed usage write must not lose the user's result. Log it at error level with the org and feature, and count it in a metric or log line that Q01 can assert on.
5. **Quota:**
   - Before a platform call: `used = sum(credits)` for the org in the current period. The period is the subscription's `current_period_start` to `current_period_end`; with no subscription period, use the calendar month in UTC. The allowance is `getEntitlements(org).aiCreditsTotal`.
   - At or above 100% with `overageAllowed` false, refuse with the oRPC error `AI_QUOTA_EXCEEDED`, which carries `used` and `allowance`. Own-key calls are never refused for quota.
   - At or above 80%, the response metadata (or a header the web client already reads, whichever fits the existing error and toast plumbing) carries `aiQuotaWarning: true`. The web shows a one-time toast per session: "Your organization has used 80% of this month's AI allowance." The mobile app shows the same text.
   - A single call may take usage over 100%. Do not try to pre-estimate. The next call is refused.
   - The quota check and sum are one indexed query. Cache within the request only.
6. **API:** `organization/ai-usage` (owner or admin) returns period usage totals: by feature, by member (top 20) and by day, plus the allowance. Members get `ai/quota` with their org's used and allowance only, for the toast and the providers screen.
7. **Mobile parity:** the providers screen shows "Included with your plan", and the 80% and 100% messages match the web.
8. **Tests:**
   - Unit tests: the credit rounding, the price lookup (an unknown model fails closed), and the period maths.
   - Integration on an isolated database:
     - Usage rows are written for generate and stream with a mock model.
     - Own-key calls record zero credits.
     - The quota refuses at 100% and passes with overage allowed.
     - RLS on `ai_usage` (Org B sees none of Org A's rows).
     - `careeros_app` cannot UPDATE or DELETE `ai_usage`.
   - A test that walks every call site (from the confirmed list) and asserts each goes through the metered model. Q01 will build on this.
   - No test calls the real Claude API. Use the existing deterministic AI stub.
9. Lingui for all new strings; run `pnpm lingui:extract`. Mark upstream edits `CAREEROS:` and list them. Add a CHANGELOG line. Log open points as questions and stop that part.

## Acceptance

- careeros-ci is fully green, and the isolation, inventory and skipped-suite guards pass.
- With platform AI on and the quota exhausted, a platform call is refused with `AI_QUOTA_EXCEEDED`, while an own-key call still works.
- Every AI call site is metered, and the call-site test proves it.
