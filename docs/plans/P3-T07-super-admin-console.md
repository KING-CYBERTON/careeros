# P3-T07: Super Admin console

**Status:** Approved (Opus, 2026-11-02). **Thread:** 1 Build. **Phase plan:** [P3-PHASE-PLAN.md](P3-PHASE-PLAN.md), decisions D3, D5, D6 and D7. **Depends on:** P3-T01 and P3-T03 merged, and P3-T04 for manual payments (if T04 has not merged, ship the rest and log a question).
**Branch:** `feat/P3-T07-super-admin-console`. **Questions:** start at Q340.

## Goal

Platform staff run CareerOS as a business from one console on the platform host: see every org, change its plan or status, record manual payments, watch usage, revenue and AI cost, impersonate a member for support, and post announcements. Every cross-org action is audited and goes through a definer function. `careeros_app` keeps no BYPASSRLS.

## Requirements

1. **Who and where.**
   - Platform admins are users with the Better Auth admin plugin's `admin` role. Two-factor authentication is required: a platform admin without 2FA enabled gets a screen that sends them to set it up, and every super-admin procedure refuses them with 403 until they have.
   - The console lives at `/admin` on the platform host only. On any org host or custom domain, the route and every super-admin procedure answer 404, decided on the server from the resolved host.
   - Granting or removing the platform admin role is not in the UI. It is done by a documented command in `tooling/careeros/` that a person with database owner access runs, which writes an audit row. Document it in `infra/staging/README.md`.
2. **Definer functions** (D6). Each one checks that the caller is a platform admin (the user id is passed in and checked against `user.role` inside the function, never trusted from the client), does its work, and writes an `audit_log` row in the same transaction with `actor_user_id`, `organization_id`, action, and a small JSON detail with no personal data beyond ids. `search_path = pg_catalog, public`, `REVOKE ALL FROM PUBLIC`, grant to `careeros_app` only. Functions:
   - `careeros_admin_list_orgs(actor, search, status, plan, limit, offset)`: id, name, slug, status, plan, seats used and limit, created, last active, AI credits used this period. No member names or emails.
   - `careeros_admin_get_org(actor, org_id)`: the above plus subscription, recent billing events and the org's owners' names and emails.
   - `careeros_admin_set_org_status(actor, org_id, status, reason)`: suspend or reactivate. Reason required.
   - `careeros_admin_set_org_plan(actor, org_id, plan_id, seats, reason)`: wraps T01's `careeros_set_org_plan`.
   - `careeros_admin_set_ai_overage(actor, org_id, allowed boolean, reason)` (D5).
   - `careeros_admin_metrics(actor, from, to)`: org counts by status and plan, new orgs, active members, MRR and revenue in the period by currency (from subscriptions and recorded payments), AI cost in USD from `ai_usage`, and AI cost per org against that org's revenue (top 50 by cost).
   - The manual payment action calls T04's `careeros_record_manual_payment`.
   - Reads are audited too, except the list and metrics, which write one audit row per call without detail.
3. **Impersonation** (D6).
   - Use the admin plugin's impersonation. Limit sessions to 60 minutes, refuse impersonating another platform admin, and require a reason.
   - Impersonation starts on the platform host and lands on the member's org host through the existing P2-T05 host-bound handoff, so the impersonation session cookie is per host like any other.
   - A banner on every page (web) while impersonating: "You are viewing as <name> (<org>). Ends at <time>. End now." The banner cannot be dismissed.
   - Start and end (including expiry) each write an audit row in the member's org and in the platform log.
   - While impersonating, these are refused: changing the member's password, email, 2FA, API keys, clipper tokens, deleting the account, billing actions, and starting another impersonation.
4. **Announcements.** A global `announcement` table (title, body as plain text up to 1,000 characters, severity `info` or `warning`, `starts_at`, `ends_at`, optional plan or org filter). Written only through a definer function by platform admins, with audit. Members see active announcements as a dismissible banner on web and mobile (dismissal stored per user). Register the table in the isolation registry as global.
5. **UI (web, platform host only):** Orgs list with search and filters, Org detail (status, plan, seats, subscription, billing events, AI usage, owners, actions with a reason dialog), Metrics, Announcements, Audit log (all orgs, filterable). Lingui strings. Mobile: none (D10, web-only console); record the exception next to the P3-T08 one.
6. **Tests.**
   - Integration on an isolated database: every definer function refuses a non-admin, an admin without 2FA, and a forged actor id; each writes exactly one audit row; `careeros_app` still has no BYPASSRLS and cannot read another org's rows outside these functions.
   - Server: every super-admin procedure answers 404 on an org host and on a custom domain.
   - Impersonation: 60-minute limit, cannot impersonate an admin, the forbidden actions are refused, start and end are audited.
   - E2e: a platform admin with 2FA suspends an org (the org's member sees the suspended state), reactivates it, and the audit log shows both.
   - This feeds P3-Q03 (super admin security tests); keep the tests easy to extend.
7. Mark upstream edits `CAREEROS:` and list them. Add a CHANGELOG line. Log open points as questions and stop that part.

## Acceptance

- careeros-ci is fully green, and the isolation, inventory and skipped-suite guards pass.
- No super-admin action is possible from an org host, without 2FA, or without an audit row. Show all three in tests.
