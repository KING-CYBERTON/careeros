# Mobile release handoff

## Billing exception (P3-T06, phase plan D10)

The web app and the native app normally offer the same features. Billing is the exception, and it needs Stephen's explicit decision (D10 is recommended and pending his confirmation; it is reversible).

- **Web:** owners buy, upgrade, change seats, update the card and cancel at `/dashboard/organization/billing`. Owners and admins see invoices and receipts.
- **Mobile:** Settings, Plan is read-only for every member. It shows the plan, status, seats and AI quota. Owners and admins also see the trial days left, the grace end date and the period end. It shows no prices, has no purchase, upgrade, seat, cancel or invoice action, and links to no web checkout. App store rules restrict selling digital subscriptions outside in-app purchase.
- **Invoices (P3-T10):** the invoice page, the invoice PDF download and the billing details (legal name, address, tax PIN, billing email) are web only. The phone has no invoice, receipt or billing details screen and makes no call to `billing.invoice`, `invoicePdf`, `profile` or `updateProfile`; no parity change.
- **Guard:** `apps/mobile/scripts/plan-screen.test.mjs` scans the phone app and fails on any call to `billing.checkout`, `portal`, `changeSeats`, `cancel`, `startTrial` `invoices`, `invoice`, `invoicePdf`, `profile` or `updateProfile`.
- **Release type:** JavaScript, copy and translation only, so it ships as an EAS Update with no new store build. It depends on the backend (`billing.get`, `organization.entitlements` and `ai.quota` already exist), so deploy the backend first.
- **If D10 changes:** an in-app purchase flow or a web link needs a store review of the screens and a new decision here; do not add a link quietly.
