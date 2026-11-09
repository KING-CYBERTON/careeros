# P3-T05 review 1

**Reviewer:** Opus, 2026-11-09. **PR:** [#101](https://github.com/KING-CYBERTON/careeros/pull/101). **Verdict:** Approved and merged on fully green CI (`0507de3`).

## Checked

- The webhook checks `x-paystack-signature` (HMAC SHA512 of the raw body under the secret key) with a constant-time compare before anything is parsed.
- The organization comes only from checkout metadata that CareerOS signed (nonce plus HMAC under a key derived from the secret key), or from provider ids saved after the first verified payment. A forged or unsigned `orgId` is refused.
- Every payment is confirmed with `GET /transaction/verify/:reference`: status success, same reference, KES, and exactly the expected amount. Verify failures that may be transient answer 500 so Paystack retries; a refusal answers 400.
- Events carry a provider event id, so replays go through the T04 dedupe.
- `billing_provider_plan` is global, in the isolation registry, with `REVOKE ALL` from the app role; the migration has a `down.sql` and the T04 `down.sql` test was adjusted to unwind it first.
- The webhook is in the public route inventory with a test against the registered routes. A test key is refused in production unless `PAYSTACK_ALLOW_TEST_KEY` is set.
- After the P3-T06 merge the checkout return URL and the reminder email link point at `/dashboard/organization/billing`.

## Answers

- **Q460 to Q464, Q466, Q467:** accepted.
- **Q461:** field names come from the Paystack docs only; confirm on a test account once Stephen adds keys.
- **Q465:** Stephen's action, listed in STATUS.md.
