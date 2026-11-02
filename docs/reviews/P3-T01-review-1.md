# P3-T01 review 1

**Reviewer:** Opus, 2026-11-02. **PR:** [#67](https://github.com/KING-CYBERTON/careeros/pull/67). **Verdict:** Approved after the follow-up commit `8b6d7f2`. Merged on fully green CI, e2e included.

## Checked

- `plan`, `subscription`, `feature_flag` and `audit_log` tables, `organization.status`, and the seed plans at placeholder prices. Prices live only in the `plan` table.
- RLS: tenant tables are ENABLE and FORCE, and registered in the isolation registry. `audit_log` is append-only for `careeros_app` (insert only; a trigger plus bootstrap revokes stop update and delete).
- Cross-org writes go through definer functions with `search_path = pg_catalog, public` and an audit row in the same transaction. `careeros_app` still has no BYPASSRLS.
- `getEntitlements(orgId)` resolves flags in the D4 order: org flag, then plan features, then global flag, then the code default.

## Answers (Q190–Q199, given in the review thread)

- **Q190:** `role:infra` accepted.
- **Q191:** add `plan.pricing_model` (`flat` or `per_seat`). Pro is `per_seat`. KES is in whole shillings.
- **Q192:** a `TRIAL_DAYS = 14` constant.
- **Q193:** the trigger plus bootstrap revokes are accepted.
- **Q194:** the effective seat limit is `subscription.seats` when the status is active, trialing or past_due and the provider is not `none`; otherwise `plan.seat_limit`.
- **Q195:** placeholders are fine until Stephen sets prices.
- **Q196:** accepted.
- **Q197:** T02 wires the entitlements cache.
- **Q198:** drop `ip` from the organization audit rows.
- **Q199:** accepted.

## Follow-ups

- T02 (enforcement), T03 (AI metering) and T04 (billing core) build on this and can start now.
