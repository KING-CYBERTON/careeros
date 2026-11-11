import type { InvoiceDocument } from "@careeros/invoice";
import { formatDay, formatMoney } from "@careeros/invoice";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { PLATFORM_DEFAULT_APP_NAME } from "@reactive-resume/utils/brand";

// CAREEROS (P3-T10): the invoice as an A4 sheet, drawn from the same view model as the PDF
// (`packages/pdf/src/invoice/document.tsx`; keep the two layouts in step). A sheet is paper: white with dark ink in both
// themes, so it prints the same as it looks. Numbers are tabular and right aligned.

type InvoiceSheetProps = { invoice: InvoiceDocument; locale: string };

const methodText = (method: InvoiceDocument["payment"]["method"]) =>
	method === "card" ? t`Card` : method === "mpesa" ? t`M-Pesa` : method === "invoice" ? t`Invoice` : "—";

export function InvoiceSheet({ invoice, locale }: InvoiceSheetProps) {
	const money = (minor: number) => formatMoney(minor, invoice.currency, locale);
	const { seller, customer, payment, tax } = invoice;
	const sellerPin = seller.taxPin;
	const customerPin = customer.taxPin;
	const number = invoice.number;
	const issued = formatDay(invoice.issuedAt, locale);
	const paidOn = invoice.paidAt ? formatDay(invoice.paidAt, locale) : null;
	const sellerDetails = [seller.email, seller.phone, sellerPin ? t`PIN ${sellerPin}` : null].filter(
		(value): value is string => Boolean(value),
	);
	const period =
		payment.periodStart && payment.periodEnd
			? `${formatDay(payment.periodStart, locale)} – ${formatDay(payment.periodEnd, locale)}`
			: "—";
	const paid = invoice.status === "paid";

	return (
		<article
			className="invoice-sheet mx-auto grid w-full max-w-[210mm] gap-7 rounded-lg bg-white p-[18mm] text-[13px] leading-5 text-[#111827] shadow-sm outline outline-[#e5e7eb] max-sm:p-6 print:max-w-none print:rounded-none print:p-0 print:shadow-none print:outline-0"
			data-testid="invoice-sheet"
		>
			<header className="flex flex-wrap items-start justify-between gap-6">
				<div className="grid min-w-0 gap-0.5">
					<p className="font-display text-[26px] leading-8 font-bold">{PLATFORM_DEFAULT_APP_NAME}</p>
					{seller.name !== PLATFORM_DEFAULT_APP_NAME && <p className="mt-2 text-sm font-semibold">{seller.name}</p>}
					{seller.addressLines.map((line) => (
						<p key={line} className="text-xs text-[#6b7280]">
							{line}
						</p>
					))}
					{sellerDetails.length > 0 && <p className="text-xs text-[#6b7280]">{sellerDetails.join("  ·  ")}</p>}
				</div>
				<div className="grid justify-items-end gap-0.5 text-end">
					<h1 className="font-display text-[28px] leading-9 font-bold text-[#337344]" data-testid="invoice-title">
						{tax ? <Trans>TAX INVOICE</Trans> : <Trans>INVOICE</Trans>}
					</h1>
					<p className="text-sm font-semibold tabular-nums" data-testid="invoice-number">
						<Trans>No. {number}</Trans>
					</p>
					<p className="text-xs text-[#6b7280]">
						<Trans>Issued {issued}</Trans>
					</p>
					{paidOn && (
						<p className="text-xs text-[#6b7280]">
							<Trans>Paid {paidOn}</Trans>
						</p>
					)}
					<span
						className={`mt-2 inline-block rounded border px-2.5 py-0.5 text-xs font-bold ${paid ? "border-[#337344] text-[#337344]" : "border-[#b45309] text-[#b45309]"}`}
						data-testid="invoice-status"
					>
						{paid ? <Trans>PAID</Trans> : <Trans>DUE</Trans>}
					</span>
				</div>
			</header>

			<section className="grid grid-cols-2 gap-6 border-t border-[#e5e7eb] pt-5 max-sm:grid-cols-1">
				<div className="grid content-start gap-0.5" data-testid="invoice-customer">
					<h2 className="text-[11px] font-bold tracking-wide text-[#6b7280] uppercase">
						<Trans>Bill to</Trans>
					</h2>
					<p className="text-sm font-semibold">{customer.name}</p>
					{customer.addressLines.map((line, index) => (
						<p key={`${index}-${line}`}>{line}</p>
					))}
					{customerPin && <p>{t`KRA PIN ${customerPin}`}</p>}
					{customer.email && <p className="text-[#6b7280]">{customer.email}</p>}
				</div>
				<div className="grid content-start gap-1">
					<h2 className="text-[11px] font-bold tracking-wide text-[#6b7280] uppercase">
						<Trans>Payment</Trans>
					</h2>
					<dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1">
						<dt className="text-xs text-[#6b7280]">
							<Trans>Method</Trans>
						</dt>
						<dd>{methodText(payment.method)}</dd>
						<dt className="text-xs text-[#6b7280]">
							<Trans>Ref</Trans>
						</dt>
						<dd className="break-all">{payment.reference ?? "—"}</dd>
						<dt className="text-xs text-[#6b7280]">
							<Trans>Period</Trans>
						</dt>
						<dd>{period}</dd>
					</dl>
				</div>
			</section>

			<section className="overflow-x-auto">
				<table className="w-full" data-testid="invoice-lines">
					<thead className="border-b border-[#111827] text-[11px] tracking-wide text-[#6b7280] uppercase">
						<tr>
							<th className="pb-2 text-start font-bold">
								<Trans>Description</Trans>
							</th>
							<th className="pb-2 text-end font-bold">
								<Trans>Qty</Trans>
							</th>
							<th className="ps-3 pb-2 text-end font-bold">
								<Trans>Unit price</Trans>
							</th>
							<th className="ps-3 pb-2 text-end font-bold">
								<Trans>Amount</Trans>
							</th>
						</tr>
					</thead>
					<tbody>
						{invoice.lines.map((line, index) => (
							<tr key={`${index}-${line.description}`} className="border-b border-[#e5e7eb]" data-testid="invoice-line">
								<td className="py-2.5 pe-3">
									<p>{line.description}</p>
									{line.detail && <p className="text-xs text-[#6b7280]">{line.detail}</p>}
								</td>
								<td className="py-2.5 text-end tabular-nums">{line.quantity}</td>
								<td className="py-2.5 ps-3 text-end whitespace-nowrap tabular-nums">
									{line.unitAmount === null ? "" : money(line.unitAmount)}
								</td>
								<td className="py-2.5 ps-3 text-end whitespace-nowrap tabular-nums">{money(line.amount)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			<section className="ms-auto grid w-full max-w-[250px] gap-1 tabular-nums" data-testid="invoice-totals">
				<div className="flex justify-between gap-4" data-testid="invoice-subtotal">
					<span>
						<Trans>Subtotal</Trans>
					</span>
					<span>{money(invoice.subtotal)}</span>
				</div>
				{tax && (
					<div className="flex justify-between gap-4" data-testid="invoice-tax">
						<span>{`${tax.label} ${tax.ratePercent}%`}</span>
						<span>{money(tax.amount)}</span>
					</div>
				)}
				<div
					className="mt-1 flex justify-between gap-4 border-t border-[#111827] pt-1.5 font-bold"
					data-testid="invoice-total"
				>
					<span>
						<Trans>Total</Trans>
					</span>
					<span>{money(invoice.total)}</span>
				</div>
				<div className="flex justify-between gap-4" data-testid="invoice-paid-amount">
					<span>
						<Trans>Amount paid</Trans>
					</span>
					<span>{money(invoice.amountPaid)}</span>
				</div>
				<div className="flex justify-between gap-4 font-bold" data-testid="invoice-due">
					<span>
						<Trans>Amount due</Trans>
					</span>
					<span>{money(invoice.amountDue)}</span>
				</div>
			</section>

			<footer className="grid gap-0.5 border-t border-[#e5e7eb] pt-3 text-xs text-[#6b7280]">
				{invoice.footer && <p>{invoice.footer}</p>}
				<p>
					<Trans>Thank you for your business.</Trans>
				</p>
			</footer>
		</article>
	);
}
