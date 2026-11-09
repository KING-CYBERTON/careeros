# P3-T06 review 1

**Reviewer:** Opus, 2026-11-09. **PR:** [#100](https://github.com/KING-CYBERTON/careeros/pull/100). **Verdict:** Approved and merged on fully green CI (`25bb1a7`).

## Checked

- The billing page is owner/admin only and reads the organization from the tenant context; `billing.invoices` is in the no-tenant-id inventory and has an integration test.
- The provider returns the customer to `/dashboard/organization/billing/return`, which waits for the webhook's confirmation instead of trusting the redirect.
- `FLAG_ALLOW_FAKE_BILLING` exists for CI e2e only and is off by default.
- Mobile shows the plan read-only (D10); the scan test confirms no billing call in the phone app.
- The card/M-Pesa selector stayed hidden behind a compile-time check until P3-T05 added `method`; it was turned on in #101.

## Answers

- **Q480:** no phone field; Paystack's hosted page collects the number. **Q481:** fake-billing flag accepted. **Q482:** integration test added. **Q483 to Q487:** accepted.
