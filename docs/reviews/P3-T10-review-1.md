# P3-T10 review 1: Invoices with a proper layout and a PDF download

**Reviewer:** Opus, 2026-11-11. **Commit:** `425a75656`. **Spec:** [P3-T10](../plans/P3-T10-invoices.md). **Verdict:** Pass, no Critical or High findings.

Checked locally on Postgres 16 with the CI roles: `@careeros/invoice` 15 tests, billing integration 19, PDF invoice 4, isolation registry and self-test 71, web billing 34, env 96, mobile scripts 100, all passing with nothing skipped; typecheck for invoice, api, web, pdf, db and env; lint, format, boundaries and the branding gate pass. The e2e job (cross-org fuzz with the new invoice id kind) runs first in CI.

| Severity | File:Line                                                        | Issue                                                                               | Impact                                                                          | Fix instruction                                                                                     |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Medium   | `packages/api/src/features/billing/router.ts` (`updateProfile`)  | A suspended organization's owner cannot save billing details (Q543).                | The owner may need a correct name and PIN on the invoice they are about to pay. | Add `billing.updateProfile` to `SUSPENDED_ORG_ALLOWED_WRITES` with a test.                          |
| Low      | `packages/api/src/features/billing/service.ts` (`getInvoicePdf`) | Reads `process.env.WEB_FONT_BASE_URL` directly instead of `env`.                    | Bypasses env validation.                                                        | Read it the same way `documents/exports.ts` resolves fonts, or drop it if the bundled font is used. |
| Info     | Q540                                                             | The SVG logo is a text wordmark, so the PDF sets the platform name in Figtree bold. | Acceptable until Stephen supplies an outlined logo.                             | None.                                                                                               |

## Answers to questions

- **Q540:** accepted. A drawn logo waits on an outlined file from Stephen.
- **Q541:** English-only PDF labels are acceptable for now; amounts and dates follow `en-KE`.
- **Q542:** keep opening it with total 0; such rows predate amounts in audit metadata.
- **Q543:** allow it (Medium finding above).
- **Q544:** the REVOKE in `infra/db/bootstrap-roles.sql` is fine.
- **Q545:** the tested hand-written sha256/base32 is acceptable; it keeps the package universal.
- **Q546:** fine at the expected size; revisit if an organization passes a few hundred payments.
- **Q547:** accepted; CI is the first e2e run.
- **Q548 and Q549:** print preview and new guide screenshots are checked on staging after deploy.
