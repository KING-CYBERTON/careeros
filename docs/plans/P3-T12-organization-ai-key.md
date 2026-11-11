# P3-T12: The organization's own AI key

**Status:** Approved (Opus, 2026-11-11). **Thread:** 1 Build. **Source:** QA improvements list item 7 (AAP-06), Stephen 2026-11-11. **Depends on:** P3-T03, P3-T08 merged; lands after P3-T10 (migration order).
**Branch:** `claude/project-thread-xohsc3`. **Questions:** start at Q580.

## Goal

An organization owner or admin pastes the company's AI provider key once, in organization settings, and every member of that organization can use it. Calls through it are paid by the organization to its provider and do not draw plan AI credits. Today a key is either the platform key (server-wide, uses plan credits) or a member's personal key.

## Decisions (Opus)

- **D1, one key per organization**, any provider the personal providers support (same provider list, model field, optional base URL and URL policy).
- **D2, order of use when a member has not picked one:** the member's own enabled provider, then the organization key, then "Included with your plan". A member who saved their own key chose it; they can still pick the organization entry in the Assistant's provider menu. The Job Clipper's "Tidy with AI" stays platform only (P5-T03) and scheduled job discovery stays platform only (P4-T02); both are follow-ups if Stephen wants them.
- **D3, metering:** calls are recorded in `ai_usage` with a new source `org_key`, cost 0 and credits 0, so the org admin's AI usage page can show them without counting them against the quota.
- **D4, who manages it:** owner and admin. Members see a read-only entry "Your organization's key" with no key preview. Admins see the preview (first 4 and last 4 characters), never the key.
- **D5, server-managed AI wins:** when `AI_PROVIDER` is set (operator-managed AI), organization keys are refused like personal ones (FORBIDDEN with the existing message).
- **D6, the key never leaves the server:** stored with `encryptCredential` (needs `ENCRYPTION_SECRET`), decrypted only when a call runs, never logged, never in audit metadata.

## Requirements

1. **Table `organization_ai_key`** (`packages/db/src/schema/ai-usage.ts` or a new `organization-ai-key.ts` exported from the schema index): `organization_id` PK FK cascade, `provider`, `model`, `base_url` null, `encrypted_api_key`, `api_key_salt`, `api_key_hash`, `api_key_preview`, `enabled` bool default false, `test_status` default `untested`, `test_error`, `last_tested_at`, `created_at`, `updated_at`, `updated_by` FK user set null. Migration with ENABLE and FORCE RLS, `tenant_isolation`, `careeros_app` SELECT, INSERT, UPDATE, DELETE, and `down.sql`. Register in the isolation registry and its test.
2. **`ai_usage.source`:** add `org_key` to `AI_USAGE_SOURCES`, the CHECK constraint (same migration) and `UsageSource` in `@careeros/ai-metering`. The recorder prices only `platform`.
3. **API** — new router `organizationAiKey` in `packages/api/src/features/organization-ai-key/` (aggregate it with the other routers, OpenAPI tag "AI"):
   - `get` → `{ configured, provider, model, baseURL, enabled, testStatus, testError, apiKeyPreview, lastTestedAt, updatedAt }` or `{ configured: false }`. Owner and admin.
   - `set` (provider, model, baseURL?, apiKey) creates or replaces; a new key or host resets `enabled=false`, `test_status=untested`. Reuse the personal provider input schema pieces and `normalizeBaseUrl`.
   - `test` runs `testConnection`, sets `enabled` on success, stores the error message on failure (same conflict guard as personal `test`).
   - `setEnabled` (only after a successful test) and `remove`.
   - Audit each write (`ai.org_key_set`, `ai.org_key_tested`, `ai.org_key_enabled`, `ai.org_key_removed`) with provider and model only.
   - Member role → FORBIDDEN. All writes need `ENCRYPTION_SECRET` (412 like personal keys).
4. **Resolution (`ai-providers/service.ts`):**
   - A reference row `org-ai:{organizationId}:{userId}` in `ai_provider` (like `platformReference`, no key) so threads and schedules keep a valid foreign key. `isOrgKeyProviderId` helper.
   - `list`: own providers, then the organization entry (when enabled and tested; `organization: true` on the response, label "Your organization's key", no preview for members), then the platform entry.
   - `getDefaultRunnable`: D2 order. `getRunnableById` for the org reference id decrypts from `organization_ai_key` and meters with `source: "org_key"`. `assertAvailable` refuses with "Your organization's AI key is turned off or was removed." when it is not enabled.
   - `getOwnedProvider`, `update`, `delete`, `test`, `setDefault` refuse the org reference id (NOT_FOUND), like the platform one.
   - Add `organization: boolean` to `AiProviderResponse` and the DTO.
5. **Web:**
   - Settings → **Organization AI key** (`/dashboard/settings/org-ai-key`), in the organization group of the settings nav next to AI usage, visible to owner and admin. Form: provider, model, base URL (when the provider takes one), API key (write only, "Saved key: abcd…wxyz"), **Test connection**, **Use for members** switch (enabled after a passing test), **Remove key** with confirmation. Copy: "Members can use this key for AI features. Calls are billed by your provider to your organization and don't use your plan's AI credits."
   - Settings → AI (member): the organization entry shows read-only with a "From your organization" badge and "Doesn't use plan credits".
   - Org AI usage page: show `org_key` usage as its own row or column ("Organization key, not counted in credits").
6. **Mobile (parity):** an org settings screen `apps/mobile/app/settings/org-ai-key.tsx` with the same get, set, test, enable and remove for owner and admin, linked from the organization settings list; the member AI providers screen shows the organization entry read-only.
7. Lingui strings on web and mobile, `pnpm lingui:extract`, `pnpm docs:gen`, user guide update with fictional data, CHANGELOG-CAREEROS line, `CAREEROS:` marks and UPSTREAM_PATCHES.

## Tests

- Service unit/integration: D2 order (own → org → platform), org key disabled falls through to platform, `getRunnableById` with the org reference meters `org_key` with 0 credits, member cannot read or write the key, admin sees preview but never the key, `AI_PROVIDER` set refuses writes, key absent from audit metadata and responses.
- Isolation: org A's key is never used or visible for org B's members (registry and a cross-org call test).
- Web and mobile component tests: admin form states (untested, passing, failing, enabled), member read-only entry.

## Acceptance

- careeros-ci green. On staging an org admin saves a key, tests it, turns it on, and a member with no personal key runs an AI feature that is recorded as `org_key` with 0 credits.
