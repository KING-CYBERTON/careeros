# P3-T04: Billing core: provider interface, subscription state machine, trials and manual invoicing

**Status:** Approved (Opus, 2026-11-02). **Thread:** 1 Build. **Phase plan:** [P3-PHASE-PLAN.md](P3-PHASE-PLAN.md), decisions D1, D2, D3 and D9. **Depends on:** P3-T01 merged.
**Branch:** `feat/P3-T04-billing-core`. **Questions:** start at Q240.

## Goal

Build everything about billing that does not depend on which payment provider Stephen picks (D1 is still open). That means the provider interface, one subscription state machine, trials and the grace period, idempotent event intake, manual invoicing for institutions, and the periodic jobs. T05 then plugs a real provider in.

## Requirements

1. **In `@careeros/billing`** (created by T01):
   - **`BillingProvider` interface:**
     - `id`;
     - `createCheckout({ orgId, planId, interval, seats, customerEmail, returnUrl })` returning `{ redirectUrl }` or `{ stkPushRequested: true }`;
     - `changeSeats(...)`;
     - `cancel(...)`;
     - `customerPortalUrl(...)`, which may be unsupported;
     - `verifyWebhook(rawBody, headers)` returning a normalized `BillingEvent` or throwing.
   - **A `fake` provider** for tests and for staging until T05 lands. It is enabled only when `BILLING_PROVIDER=fake`, which is refused at startup when `NODE_ENV=production`. Its checkout redirects to a local "approve or decline" test page on the platform host that posts a signed fake event to the fake webhook. Sign events with HMAC using `BILLING_FAKE_SECRET`.
   - **A `manual` provider** for super-admin-recorded payments (no webhook).
   - **Normalized `BillingEvent`** with these types: `checkout.completed`, `payment.succeeded`, `payment.failed`, `subscription.updated`, `subscription.canceled`. Each event carries `providerEventId`, `orgId` (from verified metadata only), `planId`, `seats`, `interval`, `periodStart`, `periodEnd`, and `amount` with `currency`.
2. **State machine:** one pure function `nextState(current, event, now)` returning the new subscription fields and org status, plus a list of audit actions. Rules:
   - **New org:** `trial`, with the `trial` plan, `trial_ends_at` = now + 14 days, and 5 seats. This replaces `personal` only for orgs created through a "start a trial" path. Personal orgs made at signup stay on `personal`. Add `billing.startTrial` (org owner only, once per org, refused for personal workspaces if T02 marks them; check `organization.metadata` or a T01 field, and log a question if neither exists).
   - **`checkout.completed` / `payment.succeeded`:** status `active`, plan and seats from the event, period from the event, `grace_ends_at` cleared.
   - **`payment.failed`:** status `past_due`, and `grace_ends_at` = now + 7 days if not already set.
   - **Grace passed (job):** `suspended`.
   - **Trial ended without payment (job):** `suspended`.
   - **`subscription.canceled`:** stays `active` until `current_period_end`, then the job sets `suspended`.
   - **A downgrade below the current member count** is refused when it is requested (T06 UI), not here. If a provider event sets seats below the members, keep the members and record an audit warning. Never remove members automatically.
   - Unit tests cover every transition, including out-of-order and duplicate events: an older `periodEnd` must not overwrite a newer one.
3. **Event intake:**
   - Add a `billing_event` table, global and not tenant-scoped, holding provider ids and normalized fields only, never card data:
     - `provider`, `provider_event_id` (unique together);
     - `organization_id`;
     - `type`, `received_at`, `processed_at`;
     - `outcome` (`applied`, `duplicate`, `ignored`, `error`) and `error`.
   - `careeros_app` gets INSERT and SELECT only through a definer function `careeros_record_billing_event(...)`, which returns whether the event is new. A duplicate returns `false`, and processing stops.
   - Applying an event calls T01's `careeros_set_subscription` and `careeros_set_org_plan` in one transaction with the event record. The audit actor is null, with `source = provider id`.
   - **HTTP route:** `POST /api/billing/webhook/:provider` in `apps/server/src/http` (mark `CAREEROS:`).
     - Raw body, capped at 256 KB, rate limited.
     - Verify the signature first. Nothing touches the database before verification succeeds.
     - Answer 200 for duplicates and for ignored types, 400 for a bad signature, and 500 only for real processing errors, so the provider retries.
     - Platform host only. The route is refused on org hosts and custom domains, so the request host can never matter (D9).
4. **Manual invoicing:**
   - `careeros_record_manual_payment(org_id, plan_id, seats, interval, period_start, period_end, amount, currency, reference, actor_user_id)`: a definer function that applies the same state transition as `payment.succeeded` with `provider = manual`, plus an audit row.
   - The procedure that calls it is part of T07 (platform admins only). T04 builds and tests the function and a TypeScript wrapper.
5. **Jobs:** extend the existing scheduler tick (P1-T07 pattern, PostgreSQL-coordinated) with a billing job that runs every 15 minutes. It suspends orgs whose grace or trial has ended, ends canceled subscriptions at period end, and writes audit rows. It is idempotent, and safe across several server instances.
6. **API** for org owners (admins read only):
   - `billing.get`: plan, status, seats, period, trial and grace dates, provider, and the available plans with their prices from the `plan` table.
   - `billing.checkout(planId, interval, seats)`: owner only. Calls the configured provider and refuses seats below the current member count.
   - `billing.changeSeats(seats)` and `billing.cancel()`: owner only.
   - `billing.portal()`: when the provider supports it.
   - Add these to T02's suspended-org allow-list.
7. **Env:**
   - `BILLING_PROVIDER` (`fake`, `paystack`, `stripe` or `none`; default `none`, which means billing is off and every org behaves as its plan says with no payments).
   - `BILLING_FAKE_SECRET`.
   - Wire both in `packages/env`, `.env.example` (placeholders), `turbo.json` pass-through, and `.env.staging.example`. Staging uses `fake` until T05.
8. **Tests:**
   - Unit tests for the state machine.
   - Integration on an isolated database:
     - a duplicate event is a no-op;
     - a bad signature never touches the database;
     - the org comes from metadata and not from the body's other fields;
     - the jobs suspend correctly;
     - manual payment works and writes audit rows;
     - `careeros_app` cannot write `billing_event` directly.
   - An e2e smoke with the fake provider: start a trial, check out Starter with 10 seats, see the status `active`.
9. Mark upstream edits `CAREEROS:` and list them. Add a CHANGELOG line. Log open points as questions and stop that part.

## Acceptance

- careeros-ci is fully green, and the guards pass.
- With `BILLING_PROVIDER=fake` on staging, an org can trial, subscribe, add seats, fail a payment, reach `past_due` and then `suspended` (with test clocks or forced job times in tests).
- No unverified webhook can change any row.
