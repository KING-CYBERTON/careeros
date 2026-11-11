# P3-T10: Invoices with a proper layout and a PDF download

**Status:** Approved (Opus, 2026-11-11). **Thread:** 1 Build. **Source:** QA improvements list item 9 (Critical), Stephen 2026-11-11, plus his follow-up "allow download as invoice option on invoice". **Depends on:** P3-T04, P3-T06 merged.
**Branch:** `claude/project-thread-xohsc3` (this thread's branch). **Questions:** start at Q540.

## Goal

Organization → Billing → Receipt today is a plain list (Date, Amount, Method, Reference, Plan, Seats, Period) and the page passes no organization name. Replace it with a real invoice: the operator's logo and business details, the customer organization's details, an invoice number, line items, subtotal, VAT and total, a Paid status, a clean A4 print layout and a **Download invoice** button that saves a PDF.

## Design reference

The layout follows the common enterprise SaaS invoice (Stripe-hosted invoice PDFs and similar), checked against Stripe's invoice requirements guide and KRA's list of tax invoice contents (2026-11-11):

```
┌──────────────────────────────────────────────────────────────┐
│ [logo]  CareerOS Ltd                      INVOICE            │
│         P.O. Box …, Nairobi              No. INV-7F3K2Q-0003 │
│         billing@…  ·  KRA PIN P05…       Issued 11 Nov 2026  │
│                                          Paid   11 Nov 2026  │
│                                          [ PAID ]            │
├──────────────────────────────────────────────────────────────┤
│ BILL TO                         PAYMENT                      │
│ Acme Careers Ltd                Method   M-Pesa              │
│ Address lines                   Ref      QK7…                │
│ KRA PIN P051…                   Period   1 Nov – 30 Nov 2026 │
│ billing email                                                │
├──────────────────────────────────────────────────────────────┤
│ Description               Qty   Unit price        Amount     │
│ Pro plan, monthly          12   KES 1,000.00   KES 12,000.00 │
│ 1 Nov 2026 – 30 Nov 2026                                     │
├──────────────────────────────────────────────────────────────┤
│                               Subtotal       KES 10,344.83   │
│                               VAT 16%         KES 1,655.17   │
│                               Total          KES 12,000.00   │
│                               Amount paid    KES 12,000.00   │
│                               Amount due          KES 0.00   │
├──────────────────────────────────────────────────────────────┤
│ footer text · "Thank you for your business"                  │
└──────────────────────────────────────────────────────────────┘
```

Neutral ink on white, one accent (the platform primary), tabular numbers, A4 with 18 mm margins. This is a commercial invoice and receipt. A KRA eTIMS tax invoice also needs a control unit serial and QR code from KRA; that integration is out of scope, and the layout leaves an optional "Tax compliance" row under the invoice number for it later.

## Decisions (Opus)

- **D1, seller details are configuration.** Stephen has not yet supplied the business name, address or KRA PIN, or said whether VAT is charged. They are server env vars (below) so they can be set without a release; nothing is hard-coded except the default name `CareerOS` (`PLATFORM_DEFAULT_APP_NAME`).
- **D2, the amount paid is the invoice total.** Checkout does not add VAT today. VAT is shown as the part of the total at `CAREEROS_INVOICE_VAT_RATE` (VAT-inclusive maths: `net = round(gross / (1 + rate))`, `vat = gross − net`). Rate 0 or unset hides the VAT row and labels the document "Invoice" instead of "Tax invoice". Whether checkout should add VAT on top of plan prices is a business question for Stephen (ESCALATIONS).
- **D3, invoice numbers are per organization.** `{PREFIX}-{ORG}-{SEQ}`: `PREFIX` from env (default `INV`), `ORG` the first 6 characters of `sha256(organization_id)` in base32 upper case, `SEQ` the payment's 1-based position, zero-padded to 4, in the organization's de-duplicated payment history ordered by `created_at, id`. Payments come from `audit_log`, which the app role cannot update or delete, so a number never changes once issued. Compute over the whole history, not only the newest 100.
- **D4, the PDF is rendered on the server** with Forme (already used for resume PDFs), so the file is identical for every browser and the numbers come from one place. The web page renders the same view model as HTML for screen and print.
- **D5, every listed invoice is Paid.** Only completed payments are recorded, so status is always Paid with "Amount due 0". The view model keeps a `status` field (`paid` | `due`) so a future past-due invoice can reuse the layout.
- **D6, customer details are owned by the org.** The owner enters a legal name, address, KRA PIN and billing email on the Billing page. They print on every invoice, including earlier ones (an invoice shows the details current when it is viewed; acceptable until eTIMS, noted in the guide).
- **D7, mobile:** billing stays read-only on mobile (P3-T06 D10). No invoices or billing details on mobile; no parity change. Add one line to the existing parity-gap note.

## Requirements

1. **Package `packages/invoice` (`@careeros/invoice`)**, Turbo tags `runtime:universal`, `role:domain`. Pure code, no DB, HTTP or DOM:
   - zod schema and type `InvoiceDocument`: `number`, `status`, `issuedAt`, `paidAt`, `currency`, `seller` {`name`, `addressLines[]`, `email`, `phone`, `taxPin`, `logo`: `"platform"`}, `customer` {`name`, `addressLines[]`, `taxPin`, `email`}, `payment` {`method`, `reference`, `periodStart`, `periodEnd`}, `lines[]` {`description`, `detail`, `quantity`, `unitAmount` (nullable), `amount`}, `subtotal`, `tax` {`label`, `ratePercent`, `amount`} | null, `total`, `amountPaid`, `amountDue`, `footer`. Money in minor units (integers).
   - `invoiceNumber(prefix, organizationId, sequence)` per D3.
   - `splitTax(gross, ratePercent)` per D2, integer-exact (`net + vat === gross`).
   - `buildLines({ planName, interval, seats, pricingModel, net, periodStart, periodEnd })`: per-seat plans give one line with quantity = seats and `unitAmount = net / seats` only when it divides exactly, otherwise quantity 1 with "N seats" in the detail and `unitAmount` null. Flat plans give quantity 1.
   - `formatMoney(minor, currency, locale)` used by both HTML and PDF.
2. **Env** (`packages/env/src/server.ts`, `.env.example` with placeholders and comments, `infra/staging/.env.staging.example`, `turbo.json` `globalPassThroughEnv`): `CAREEROS_INVOICE_SELLER_NAME`, `CAREEROS_INVOICE_SELLER_ADDRESS` (lines separated by `|`), `CAREEROS_INVOICE_SELLER_EMAIL`, `CAREEROS_INVOICE_SELLER_PHONE`, `CAREEROS_INVOICE_SELLER_TAX_PIN`, `CAREEROS_INVOICE_TAX_LABEL` (default `VAT`), `CAREEROS_INVOICE_VAT_RATE` (number 0–100, default 0), `CAREEROS_INVOICE_PREFIX` (default `INV`, `^[A-Z0-9]{1,8}$`), `CAREEROS_INVOICE_FOOTER`. All optional.
3. **Table `organization_billing_profile`** (`packages/db/src/schema/billing.ts`): `organization_id` PK FK cascade, `legal_name` (≤ 200), `address` (≤ 500, newline separated), `tax_pin` (≤ 32), `billing_email` (≤ 254, same single-address CHECK as branding), `updated_at`, `updated_by` FK user set null. Migration via `pnpm db:generate` plus the RLS block the other tenant tables use: ENABLE and FORCE RLS, `tenant_isolation`, `careeros_app` SELECT, INSERT, UPDATE. Ship `down.sql`. Register in the isolation registry and its integration test.
4. **API** (`packages/api/src/features/billing`):
   - `listInvoices` gains `number` per row (D3) and keeps its other fields.
   - `billing.invoice` GET `/billing/invoices/{id}` → `InvoiceDocument`. Owner or admin of the active organization only; an id from another organization is NOT_FOUND. Plan name and pricing model from `plan`; customer from the billing profile, falling back to the organization's name.
   - `billing.invoicePdf` GET `/billing/invoices/{id}/pdf` → file, `content-disposition: attachment; filename="<number>.pdf"`, same access rules, `pdfExportRateLimit`. Follow `documents/exports.ts` for the file response.
   - `billing.profile` GET (owner, admin) and `billing.updateProfile` POST (owner only, zod-validated, trims, empty string → null). Audit `billing.profile_updated` with the changed field names only, no values.
   - Run `pnpm docs:gen`.
5. **PDF** (`packages/pdf`, new export `./invoice` → `src/invoice/index.tsx`, server only): `createInvoicePdfFile(doc: InvoiceDocument, { locale }): Promise<File>` built with the Forme primitives (`Document`, `Page size="A4"`, `View`, `Text`, `Svg`/`Image`) and the bundled Figtree font through the existing font resolution. Embeds the platform logo (`apps/web/public/logo/light.svg` content, copied into the package as a module, not read from the web app at runtime). Layout as in Design reference; long customer addresses wrap; one page for one line item.
6. **Web** (`apps/web/src/features/billing`):
   - Invoices table: columns Invoice no., Date, Amount, Method, Status (Paid badge), and a "View" action. Keep `data-testid`s.
   - Route `/dashboard/organization/billing/receipt/$invoiceId` stays (links already exist) and renders `InvoiceSheet` from `billing.invoice`: the layout above as an A4 sheet on screen (`max-w-[210mm]`, white background in both themes), print CSS (`@page { size: A4; margin: 18mm }`, app chrome hidden). Actions above the sheet: **Download invoice** (calls `billing.invoicePdf`, saves the blob as `<number>.pdf`, shows a spinner and a toast on failure) and **Print**.
   - Billing page: a "Billing details" section (legal name, address, KRA PIN, billing email). Owner edits and saves; admin sees it read-only. Helper text: "Printed on your invoices."
   - Lingui macros for every string; run `pnpm lingui:extract`.
7. **Docs:** update the billing user guide (find it under `docs/` via the guide map in `docs/contributing/career-platform.mdx`) with the invoice, the download and billing details, and fictional data only. CHANGELOG-CAREEROS line. Mark upstream edits `CAREEROS:` and list them in `docs/UPSTREAM_PATCHES.md`.

## Tests

- `@careeros/invoice` unit: numbering format and stability, `splitTax` for 0, 16 and odd amounts (sums exact), `buildLines` for flat, per-seat divisible and not divisible.
- API integration (`invoices.integration.test.ts`, extend): `number` sequence over more than 100 payments; `billing.invoice` for owner and admin, FORBIDDEN for a member, NOT_FOUND across organizations; profile read/update permissions; `invoicePdf` returns `application/pdf` starting with `%PDF` and the attachment header.
- PDF integration: the rendered PDF's extracted text contains the invoice number, seller name, customer name, VAT row only when the rate is above 0, and the total.
- Web component tests: sheet renders number, Paid badge, lines and totals; VAT row hidden at rate 0; Download calls the PDF procedure; billing details editable by owner only.
- Isolation registry test includes `organization_billing_profile`.

## Acceptance

- careeros-ci green. An owner on staging opens an invoice, sees the full layout, downloads a PDF that opens as one A4 page, and prints a clean page.
