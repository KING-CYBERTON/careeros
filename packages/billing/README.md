# @careeros/billing

Plans, entitlements and the audit trail for CareerOS (Phase 3, P3-T01). Reads only: nothing here enforces a limit (P3-T02), meters AI (P3-T03) or talks to a payment provider (P3-T04).

- `getEntitlements(orgId)` returns what an organization is allowed right now: plan, status, seat limit and use, AI credits, resolved feature flags, overage switch and `readOnly` (suspended). It runs inside `withOrgContext`, so row-level security applies.
- `isFeatureEnabled(orgId, key)` is a thin wrapper.
- `FEATURE_KEYS` and `FeatureKey` list the feature keys (PRODUCT.md section 11).
- `audit(ctx, action, target, metadata)` adds a row to the current organization's audit log through the app role.
- `runWithEntitlementsCache(fn)` opens a cache for one request. Without it nothing is cached.

## Feature resolution (phase plan D4)

The organization's flag, then the plan's `features`, then the global flag, then the code default (off). The first source with an opinion wins, including an explicit `false`.

## AI credit pool (consumed by P3-T03)

`aiCreditsTotal = plan.ai_credits_per_seat x max(subscription.seats, member count)`. Pending invitations do not enlarge the pool. `seatsUsed` is members plus pending, unexpired invitations.

## Who writes plan, status and subscription state

Nobody in the app role. `careeros_app` has `SELECT` only on `plan`, `subscription` and `feature_flag`, and `SELECT` and `INSERT` on `audit_log`; a trigger on `organization` refuses a change to `status`, `plan_id` or `status_changed_at` by that role. The writes go through these `SECURITY DEFINER` functions (migration `20261102174208_plans_entitlements`), which write an audit row in the same transaction. They check nothing about the caller: T04 (billing events) and T07 (platform admins) check that in TypeScript, and each caller is reviewed then.

| Function                                                                                                     | May change                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `careeros_set_org_plan(org_id, plan_id, status, actor_user_id, reason)`                                      | `organization.plan_id`, `status`, `status_changed_at`; `subscription.plan_id`; writes `org.plan_changed` and/or `org.status_changed`                                                                                                    |
| `careeros_set_subscription(org_id, fields jsonb, actor_user_id, source)`                                     | `subscription` columns `provider`, `provider_customer_id`, `provider_subscription_id`, `status`, `seats`, `billing_interval`, the period and trial/grace dates, `ai_overage_allowed`; unknown keys raise; writes `subscription.updated` |
| `careeros_audit_platform(actor_user_id, impersonator_user_id, action, target_type, target_id, metadata, ip)` | inserts one `audit_log` row with a null organization                                                                                                                                                                                    |

`careeros_uuidv7()` (time-sortable ids for audit rows written in SQL) and `create_organization_subscription()` (the trigger that gives a new organization its `none` subscription row) are helpers, not write paths for the app.

Prices and AI credit amounts in the seeded plans are placeholders until the owner sets them (D2).
