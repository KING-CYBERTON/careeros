# P3-T11: OpenRouter as the platform AI provider

**Status:** Approved (Opus, 2026-11-11). **Thread:** 1 Build. **Source:** QA improvements list item 8 (AAP-06), Stephen 2026-11-11. **Depends on:** P3-T03 merged.
**Branch:** `claude/project-thread-xohsc3`. **Questions:** start at Q560.

## Goal

The "Included with your plan" provider only accepts an Anthropic key today (`ANTHROPIC_API_KEY`, provider hard-coded to `anthropic` in `packages/api/src/features/ai/platform.ts`, `ai-providers/service.ts`, `discovery/ai-match.ts` and the `metered` guard in `ai/service.ts`). Let the operator run the platform provider through OpenRouter instead, with metering and credits staying correct.

## Decisions (Opus)

- **D1, one platform provider at a time**, chosen by `CAREEROS_AI_PLATFORM_PROVIDER` = `anthropic` (default, today's behaviour) or `openrouter`. The key comes from `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` to match. With `openrouter` selected and no `OPENROUTER_API_KEY`, platform AI is off (same as no key today); no silent fallback to the other key.
- **D2, model ids stay canonical in config.** `CAREEROS_AI_MODEL_GENERATION` and `CAREEROS_AI_MODEL_FAST` keep their defaults (`claude-sonnet-5-5`, `claude-haiku-5-5`). Under OpenRouter, an id without `/` is translated to the OpenRouter slug through a fixed map (`claude-sonnet-5-5` → `anthropic/claude-sonnet-5.5`, `claude-haiku-5-5` → `anthropic/claude-haiku-5.5`); an id with `/` is used as given. An id with no map entry and no `/` is refused (fail closed) under OpenRouter.
- **D3, prices by alias.** `@careeros/ai-metering` gets `MODEL_PRICE_ALIASES` (OpenRouter slug → canonical id); `priceFor` resolves an alias before lookup, so `ai_usage.model` records the id actually sent and is priced like the canonical model. OpenRouter passes provider token prices through unchanged; its fee on buying OpenRouter credits is operator overhead and is not added to member credits (note in the price table comment). An OpenRouter slug that is not in the alias table is refused, as today.
- **D4, the guard is provider-agnostic.** `getModel` refuses the platform key without platform metering whatever `provider` the caller passes (today it only checks when provider is `anthropic`).
- **D5, Anthropic-only request options.** Any `providerOptions.anthropic` (for example prompt caching in `agent/service.ts`) is passed only when the resolved provider is `anthropic`; under OpenRouter the call runs without it. Grep for every such use and list them in the PR.

## Requirements

1. **Env:** `CAREEROS_AI_PLATFORM_PROVIDER` (`z.enum(["anthropic","openrouter"]).default("anthropic")`), `OPENROUTER_API_KEY` (optional, server only, same comment as `ANTHROPIC_API_KEY`). Add to `packages/env/src/server.ts`, `.env.example` (placeholders), `infra/staging/.env.staging.example`, `turbo.json` `globalPassThroughEnv` and the test-task `env` arrays that list `ANTHROPIC_API_KEY`.
2. **`ai/platform.ts`:** add `platformProvider(): "anthropic" | "openrouter"`; `platformKeyConfigured`, `platformApiKey` and `isPlatformApiKey` use the selected provider's key; `platformModelFor(feature)` returns the wire model id per D2 and still calls `priceFor` on it. Export the slug map for tests.
3. **Call sites:** replace hard-coded `"anthropic"` with `platformProvider()` in `platformReference` (`ai-providers/service.ts`), `discovery/ai-match.ts`, and anywhere a grep for `provider: "anthropic"` near platform code finds it. The OpenRouter model is built through the existing `getRawModel` `openrouter` branch (`createOpenAICompatible`, default base URL from `AI_PROVIDER_DEFAULT_BASE_URLS`).
4. **Metering:** D3 and D4. `meterLanguageModel` writes `provider = "openrouter"` for these rows.
5. **Docs:** a short "Platform AI through OpenRouter" section in the self-hosting AI guide (find the page that documents `ANTHROPIC_API_KEY`), CHANGELOG-CAREEROS line, UPSTREAM_PATCHES for any upstream file touched.

## Tests

- `platform.ts` unit (env mocked): provider selection, key selection, OpenRouter with no key → not configured, model mapping both ways, unmapped id refused.
- `prices` unit: alias priced like canonical; unknown slug refused.
- `service.test.ts`: the platform key with provider `openrouter` and no platform metering throws `PLATFORM_KEY_UNMETERED`.
- `ai-match` and `ai-providers` service tests: platform runnable and reference row use `openrouter` and the mapped model when selected.
- No test calls a real provider.

## Acceptance

- careeros-ci green. On staging, setting `CAREEROS_AI_PLATFORM_PROVIDER=openrouter` with an OpenRouter key makes "Included with your plan" work and the org's AI usage page shows the credits used.
