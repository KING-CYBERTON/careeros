# P3-T05: Paystack provider: card subscriptions, M-Pesa period payments, webhooks

**Status:** Approved (Opus, 2026-11-08). **Thread:** 1 Build. **Plan:** P3-PHASE-PLAN.md D1 (Stephen chose Paystack, 2026-11-08), D9; P3-T04 billing core. **Depends on:** P3-T04 merged.
**Branch:** `feat/P3-T05-paystack-provider`. **Questions:** start at Q460.

## What Paystack offers (checked against its docs, 2026-11-08)

- **Kenya channels:** card (Visa, Mastercard, Amex) and `mobile_money` (M-Pesa STK push `mpesa`; Airtel `atl`). Bank transfer (Pesalink) needs enablement, so it is out of scope. Currency is KES, and amounts are in the subunit (cents).
- **Subscriptions:** card only. M-Pesa authorizations are not reusable, so M-Pesa cannot renew on its own.
- **Webhooks:** header `x-paystack-signature`, HMAC SHA512 of the raw body keyed with the secret key. Answer 200 quickly, because Paystack retries for 72 hours.
- **Customer self-service:** `GET /subscription/:code/manage/link` returns a hosted page to update the card or cancel.

## Goal

An org owner pays for a plan by card, which renews automatically, or by M-Pesa, which pays one period at a time with a reminder to pay the next. Paystack events drive the T04 state machine, and nothing about plans, seats or quotas changes.

## Requirements

1. **Adapter** `packages/billing/src/providers/paystack.ts`, implementing `BillingProvider`, enabled by `BILLING_PROVIDER=paystack`.
   - New env vars `PAYSTACK_SECRET_KEY` and `PAYSTACK_PUBLIC_KEY`, required when the provider is paystack. Add them to packages/env, .env.example (placeholders only) and turbo.json pass-through. At startup, refuse an `sk_test_` key when `NODE_ENV=production` unless `PAYSTACK_ALLOW_TEST_KEY=true` (for staging).
   - A small typed HTTP client over `fetch` to `https://api.paystack.co`, with a timeout, no retries on POST, and errors mapped to readable messages. Never log the secret key, card data or full payloads; log references and event types only.
2. **Plans:** a Paystack plan per (CareerOS plan, interval, currency), created lazily and cached in a new `billing_provider_plan` table (global, platform-only; the app role has no write except through a definer function). Price comes from the `plan` table only.
3. **Checkout** (`createCheckout`):
   - `method: card`: `POST /transaction/initialize` with `plan`, the seat quantity priced in (Paystack plans have no quantity, so the plan code is per seat count, or the amount is `price × seats` with `invoice_limit` unset; choose one and log the choice as a question), `channels: ["card"]`, `callback_url` = the server-built return URL, and `metadata` (stringified JSON) holding `orgId`, `planId`, `interval`, `seats` and a server-signed nonce. Return `{ redirectUrl: authorization_url }`.
   - `method: mpesa`: a one-period charge via `POST /transaction/initialize` with `channels: ["mobile_money"]` and the same metadata. Return the redirect. A direct STK push from our page is out of scope for v1.
   - Extend `CheckoutInput` with an optional `method` and keep the fake provider working. `billing.checkout` gains the method argument.
4. **Webhook** (`verifyWebhook`, route already at `POST /api/billing/webhook/paystack`):
   - Verify HMAC SHA512 over the raw bytes with a constant-time compare before parsing anything.
   - Map `charge.success` (first payment or an M-Pesa period) to `checkout.completed` or `payment.succeeded`, `invoice.payment_failed` to `payment.failed`, `subscription.not_renew` and `subscription.disable` to `subscription.canceled`, and `subscription.create` to `subscription.updated`. Every other type is `WebhookIgnored`.
   - **Org from verified data only:** read `orgId` from the signed event's metadata and check the nonce. For subscription events that carry no metadata, resolve through the stored `provider_subscription_id` or `provider_customer_id` saved on the first `charge.success`. Never use the host or unsigned fields.
   - **Verify amount and currency:** after a `charge.success`, call `GET /transaction/verify/:reference` and refuse the event (payload error, logged) if the amount, currency or status do not match the expected price for the plan, interval and seats.
   - Event id: the transaction or subscription id plus the event type, as `provider_event_id`. Duplicates are no-ops (T04).
5. **Renewal for M-Pesa:** the T04 periodic job already handles period end and grace. Add a reminder email 3 days before the end, and on the last day for M-Pesa-paid orgs, with a pay link to the billing page. Use the existing email package and branding, with Lingui strings.
6. **Seats and cancel:**
   - `changeSeats` for card subscriptions: disable the old subscription at period end and create a new one with the new seat count from the next period; record the pending change. For M-Pesa, the next payment uses the new count.
   - `cancel`: `POST /subscription/disable` (card). M-Pesa simply does not renew.
   - `customerPortalUrl`: the manage link for card subscriptions; null for M-Pesa.
7. Mark upstream edits `CAREEROS:`, list them in docs/UPSTREAM_PATCHES.md, and add a CHANGELOG line. Update the self-hosting docs with the Paystack setup steps: dashboard keys, webhook URL, and test mode. Use placeholders only.

## Tests

- **Unit:** the signature check (valid, tampered body, wrong key, missing header, timing-safe compare), the event mapping for every listed type, amount verification, metadata nonce checks, and the env refusal of test keys in production.
- **Integration (isolated DB, Paystack HTTP mocked with recorded fixture shapes; no real network):**
  - card checkout then `charge.success` makes the org active;
  - M-Pesa period payment then expiry, grace and reminder emails;
  - `invoice.payment_failed` puts the org in grace;
  - cancel;
  - a duplicate event is a no-op;
  - a forged event (bad signature) is refused with 400 and changes nothing;
  - an event naming another org in unsigned fields still resolves the right org;
  - an amount mismatch is refused.
- Add the webhook route to the isolation inventory as a public, signature-verified route.

## Acceptance

- careeros-ci is fully green, including the isolation, inventory and skipped-suite guards.
- With Paystack test keys (Stephen adds them), a card checkout and an M-Pesa payment complete end to end on staging.
