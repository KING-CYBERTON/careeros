# P3-T01: Plans, subscriptions, feature flags, audit log and entitlements

**Status:** Approved (Opus, 2026-11-02). **Thread:** 1 Build. **Phase plan:** [P3-PHASE-PLAN.md](P3-PHASE-PLAN.md), decisions D2, D3, D4 and D7.
**Branch:** `feat/P3-T01-plans-entitlements`. **Questions:** start at Q190.

## Goal

Add the data that the rest of Phase 3 builds on: plans, an org's subscription and status, feature flags and an append-only audit log. Add one server function that answers "what is this org allowed right now". No app-role path may let an org change its own plan, status or seats. Those writes go only through definer functions that later tasks call (T04 billing, T07 super admin).

## Requirements

1. **New package `packages/billing` (`@careeros/billing`)**, following the `@careeros/tenancy` package layout (PRODUCT.md §5.2). Turbo tags: `runtime:server`, `role:domain`. It holds the plan and entitlement types, `getEntitlements` and the feature-flag resolver. DB schema stays in `packages/db`.
2. **Schema** in a new `packages/db/src/schema/billing.ts`, exported from the schema index:
   - `plan` (global, not tenant-scoped):
     - `id` text PK, a stable key: `personal`, `trial`, `starter`, `pro`, `enterprise`.
     - `name`.
     - `price_monthly_usd_cents`, `price_annual_usd_cents`, `price_monthly_kes`, `price_annual_kes`: integers, nullable (null means "contact us").
     - `seat_limit`: integer, nullable (null means unlimited).
     - `ai_credits_per_seat`: integer, not null, default 0.
     - `features`: jsonb, not null, default `{}`, a map of feature key to boolean.
     - `active`: boolean, not null, default true.
     - `created_at`, `updated_at`.
   - Columns added to `organization`:
     - `status` text, not null, default `'active'`, CHECK in (`trial`, `active`, `past_due`, `suspended`).
     - `plan_id` text, not null, default `'personal'`, FK to `plan.id`.
     - `status_changed_at` timestamptz.
     - Mark this upstream-adjacent table edit `CAREEROS:`. Check that Better Auth's organization plugin tolerates the extra columns (it should ignore them), and add a test that creating an org through the plugin still works.
   - `subscription` (tenant-scoped, one row per org):
     - `organization_id`: PK and FK, ON DELETE CASCADE.
     - `plan_id`: FK.
     - `provider`: text, CHECK in (`none`, `manual`, `paystack`, `stripe`, `mpesa`), default `none`.
     - `provider_customer_id`, `provider_subscription_id`: nullable.
     - `status`: text, CHECK in (`trialing`, `active`, `past_due`, `canceled`, `none`), default `none`.
     - `seats`: integer, not null, default 1, CHECK > 0.
     - `billing_interval`: text, CHECK in (`month`, `year`), nullable.
     - `current_period_start`, `current_period_end`, `trial_ends_at`, `grace_ends_at`: nullable timestamptz.
     - `ai_overage_allowed`: boolean, not null, default false.
     - `created_at`, `updated_at`.
   - `feature_flag`:
     - `id` PK.
     - `organization_id`: nullable FK, ON DELETE CASCADE. Null means a global flag.
     - `key`: text, CHECK matching `^[a-z][a-z0-9_.]{1,63}$`.
     - `enabled`: boolean, not null.
     - `updated_by`: FK to user, ON DELETE SET NULL.
     - `updated_at`.
     - Uniqueness on (`organization_id`, `key`), treating null as one value: a unique index on `coalesce(organization_id, '')`, `key`.
   - `audit_log`:
     - `id` PK (uuidv7, so ids sort by time).
     - `organization_id`: nullable FK, ON DELETE SET NULL. Null means a platform-level action.
     - `actor_user_id`: FK to user, ON DELETE SET NULL.
     - `impersonator_user_id`: nullable FK to user, ON DELETE SET NULL.
     - `action`: text, not null, CHECK matching `^[a-z][a-z0-9_.]{1,63}$`.
     - `target_type`, `target_id`: nullable text.
     - `metadata`: jsonb, not null, default `{}`.
     - `ip`: nullable text.
     - `created_at`.
     - Index on (`organization_id`, `created_at` desc).
3. **Migration** via drizzle-kit `generate`, then hand-add grants, RLS and functions in the same file, following the P2-T01 and T09 patterns:
   - **`plan`:** `careeros_app` gets SELECT only. Seed the five plans:
     - `personal`: 1 seat, small AI credits, no admin features.
     - `trial`: 5 seats, 14-day trial.
     - `starter`: 50 seats.
     - `pro`: per seat, null seat limit.
     - `enterprise`: null prices.
     - All prices are **placeholders** marked in a SQL comment (D2). Pick feature keys from PRODUCT.md §11 (`custom_domain`, `job_discovery`, `admin_analytics`, `email_templates`, `sso`, `platform_ai`) and list them in the PR. Backfill every existing org to `plan_id = 'personal'`, `status = 'active'`.
   - **`organization`:** `careeros_app` must not be able to change `status`, `plan_id` or `status_changed_at`. Use a column-level REVOKE UPDATE on those columns, or a BEFORE UPDATE trigger that raises unless a `careeros.billing_write` transaction setting is set by the definer functions. Pick one, explain it in the PR, and test it.
   - **`subscription`:** ENABLE and FORCE RLS with the standard `tenant_isolation` policy. `careeros_app` gets SELECT only, no INSERT, UPDATE or DELETE. Backfill one `none` row per org. New orgs get their row the same way P2-T01 creates branding rows; reuse that mechanism.
   - **`feature_flag`:** ENABLE and FORCE RLS. The SELECT policy allows `organization_id = current org OR organization_id IS NULL`. `careeros_app` gets SELECT only.
   - **`audit_log`:** ENABLE and FORCE RLS. `careeros_app` gets SELECT and INSERT, and no UPDATE or DELETE. The SELECT policy covers the current org's rows. The INSERT check requires `organization_id` = current org. Platform rows (null org) come only through the definer in item 4.
   - Register all four tables in the isolation registry. `plan` is global, and `feature_flag` and `audit_log` are tenant tables with a nullable org; classify them so the unclassified-tables check stays green, and explain the classification.
   - Ship a `down.sql`.
4. **Definer functions** (SECURITY DEFINER, `search_path = pg_catalog, public`, EXECUTE revoked from PUBLIC and granted to `careeros_app` with the conditional-grant pattern):
   - `careeros_set_org_plan(org_id, plan_id, status, actor_user_id, reason)`: updates `organization.plan_id`, `status` and `status_changed_at`, and the subscription's `plan_id`. It writes an `audit_log` row (`org.plan_changed` or `org.status_changed`) in the same transaction. T01 only builds and tests it. Who may call it (T04 for billing events, T07 for platform admins) is checked in TypeScript by those tasks, and each caller is reviewed then.
   - `careeros_set_subscription(org_id, fields jsonb, actor_user_id, source)`: updates the subscription row from an allow-listed set of fields, with an audit row (`subscription.updated`). Unknown keys raise.
   - `careeros_audit_platform(actor_user_id, impersonator_user_id, action, target_type, target_id, metadata, ip)`: inserts an audit row with a null org.
   - Name the PR's grep-able list of every function and what it may change.
5. **`@careeros/billing`:**
   - `getEntitlements(orgId)` returns `{ planId, status, seatLimit, seatsUsed, aiCreditsPerSeat, aiCreditsTotal, features: Record<string, boolean>, overageAllowed, readOnly }`.
     - `seatsUsed` counts members plus pending invitations.
     - `aiCreditsTotal` is the per-seat credits × max(seats paid, members). Note the formula in code; T03 consumes it.
     - `readOnly` is true when `status = 'suspended'`.
     - Features resolve in D4 order: the org's flag, then the plan's `features`, then the global flag, then the code default.
     - It runs inside the existing org context helpers, so RLS applies.
     - Cache per request only, never across requests.
   - `isFeatureEnabled(orgId, key)` is a thin wrapper.
   - Export the feature-key list as a const, with a type.
   - `audit(ctx, action, target, metadata)` inserts an org-scoped `audit_log` row through the app role.
6. **API (read-only in this task).** Add `organization/entitlements` (protected, current org, any member) returning `getEntitlements`, and `organization/audit` (owner or admin, paginated, newest first). No write procedures in this task.
7. **Tests:**
   - Unit tests for flag resolution order and the entitlement maths.
   - An integration test on an isolated database:
     - RLS on `subscription`, `feature_flag` and `audit_log` (Org B sees nothing of Org A's; global flags are visible to both).
     - `careeros_app` cannot UPDATE `organization.status` or `plan_id`, cannot write `subscription`, and cannot UPDATE or DELETE `audit_log`.
     - Each definer function does its job, writes its audit row, and rejects unknown fields.
     - The backfill, and creation-time subscription rows.
     - Org creation through Better Auth still works.
   - The new procedures are added to the cross-org fuzz inventory automatically; confirm the inventory test stays green.
8. **No enforcement yet** (that is T02), no AI metering (T03), no billing provider (T04) and no UI.
9. Mark upstream edits `CAREEROS:` and list them in `docs/UPSTREAM_PATCHES.md`. Add a CHANGELOG-CAREEROS line. Log anything this spec does not settle in docs/questions.md, then stop that part.

## Acceptance

- careeros-ci is fully green: static, unit and e2e. The isolation, inventory and skipped-suite guards pass.
- The migration applies on a fresh database and on a copy with existing orgs, and `down.sql` reverts it.
- No app-role SQL path can change an org's plan, status, seats or subscription. Show this with tests.
