# P3-T06: Org owner billing page (web), read-only plan view (mobile)

**Status:** Approved (Opus, 2026-11-08). **Thread:** 1 Build. **Plan:** P3-PHASE-PLAN.md D10, P3-T04 and P3-T05. D10 follows the recommendation, mobile read-only, pending Stephen's confirmation; this is reversible. **Depends on:** P3-T04 merged. Works with the fake provider until P3-T05 merges; coordinate the `method` argument with T05.
**Branch:** `feat/P3-T06-billing-ui`. **Questions:** start at Q480.

## Goal

An org owner sees their plan, seats, status, AI usage and invoices, and can upgrade, change seats, pay by card or M-Pesa, and cancel, all from the web app. Members on mobile see the plan and quota read-only.

## Requirements

1. **Web route** `/dashboard/organization/billing` (owner and admin can view; only the owner can act). It uses the existing `billing.get`, `billing.checkout`, `billing.portal` and seat and cancel procedures; add only what is missing and log a question if you add one.
   - **Summary:** plan name, status (trial with days left, active, past due with grace end date, suspended, canceled at period end), seats used and seat limit, current period, payment method (card or M-Pesa), and the AI credits used and remaining this period (from P3-T03).
   - **Plans:** cards for each plan from the `plan` table, with monthly and annual prices in KES and USD as the table holds them. Never hard-code prices. Show the current plan.
   - **Checkout:** choose plan, interval, seats (not below the current member count, with a message) and method (Card renews automatically; M-Pesa pays one period at a time). Redirect to the provider. The return page shows "Payment received, updating your plan" and polls `billing.get` until the status changes, for at most 60 seconds, then explains that confirmation may take a few minutes.
   - **Invoices:** a list of payments from the billing events (date, amount, currency, method, reference, period). A printable receipt view per payment, with no card data.
   - **Manage:** "Update card or cancel" opens the provider portal when there is one. Cancel shows a confirmation that the org keeps working until the period end.
   - **Banners** across the app for owners: trial ending in 3 days or less, past due (grace end date), suspended (link to billing). Members see a short notice to contact their owner.
2. **Billing off:** when `BILLING_PROVIDER=none`, the page shows the plan read-only and says billing is managed by the platform.
3. **Mobile (D10):** a read-only Plan screen under organization settings, showing plan, status, seats and AI quota, with no prices, purchase, upgrade or links to web checkout. Add the exception to the Mobile parity gaps table and `.agents/docs/mobile-release-handoff.md`.
4. Use Lingui strings for web and mobile and run extract. Update the user guide with fictional screenshots. Mark upstream edits `CAREEROS:`, list them in docs/UPSTREAM_PATCHES.md, and add a CHANGELOG line.

## Tests

- **Web component tests:** each status state, a seat count below members refused, prices rendered from data, owner-only actions hidden for admins, and billing off.
- **E2E with the fake provider:** the owner upgrades and approves on the fake page, sees the plan active, the invoice listed, then cancels. A member sees no billing actions.
- **Mobile:** read-only screen states, and no purchase entry anywhere (assert on the rendered tree).
- No test calls a real payment provider.

## Acceptance

- careeros-ci is fully green.
- An owner completes an upgrade on staging with the fake provider today, and with Paystack test keys once P3-T05 merges.
