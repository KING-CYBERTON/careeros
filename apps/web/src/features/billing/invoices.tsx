import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Button } from "@reactive-resume/ui/components/button";
import { formatPaid } from "./lib";
import { SettingsSection } from "@/features/settings/section";

// CAREEROS (P3-T06): the payments list and the printable receipt. Both show ids, amounts and periods; no card data.

export type InvoiceRow = {
	id: string;
	date: Date;
	amount: number | null;
	currency: string | null;
	provider: string;
	method: "card" | "mpesa" | null;
	reference: string | null;
	planId: string | null;
	seats: number | null;
	periodStart: Date | null;
	periodEnd: Date | null;
};

export const methodLabel = (invoice: Pick<InvoiceRow, "method" | "provider">) =>
	invoice.method === "card"
		? t`Card`
		: invoice.method === "mpesa"
			? t`M-Pesa`
			: invoice.provider === "manual"
				? t`Invoice`
				: "—";

const day = (date: Date | null, locale: string) =>
	date ? date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : "—";

export const periodLabel = (invoice: Pick<InvoiceRow, "periodStart" | "periodEnd">, locale: string) =>
	invoice.periodStart && invoice.periodEnd
		? `${day(invoice.periodStart, locale)} – ${day(invoice.periodEnd, locale)}`
		: "—";

type InvoiceListProps = { invoices: InvoiceRow[]; locale: string };

export function InvoiceList({ invoices, locale }: InvoiceListProps) {
	return (
		<SettingsSection title={<Trans>Invoices</Trans>} description={<Trans>Payments made for this organization.</Trans>}>
			{invoices.length === 0 ? (
				<p className="text-sm text-ink-2" data-testid="invoices-empty">
					<Trans>No payments yet.</Trans>
				</p>
			) : (
				<div className="overflow-x-auto rounded-xl outline outline-line">
					<table className="w-full text-sm" data-testid="invoice-table">
						<thead className="text-start text-[13px] text-ink-3">
							<tr>
								<th className="p-3 text-start font-medium">
									<Trans>Date</Trans>
								</th>
								<th className="p-3 text-start font-medium">
									<Trans>Amount</Trans>
								</th>
								<th className="p-3 text-start font-medium">
									<Trans>Method</Trans>
								</th>
								<th className="p-3 text-start font-medium">
									<Trans>Reference</Trans>
								</th>
								<th className="p-3 text-start font-medium">
									<Trans>Period</Trans>
								</th>
								<th className="p-3" />
							</tr>
						</thead>
						<tbody className="divide-y divide-line">
							{invoices.map((invoice) => (
								<tr key={invoice.id} data-testid="invoice-row">
									<td className="p-3">{day(invoice.date, locale)}</td>
									<td className="p-3 tabular-nums">{formatPaid(invoice.amount, invoice.currency, locale) ?? "—"}</td>
									<td className="p-3">{methodLabel(invoice)}</td>
									<td className="max-w-40 truncate p-3" title={invoice.reference ?? undefined}>
										{invoice.reference ?? "—"}
									</td>
									<td className="p-3">{periodLabel(invoice, locale)}</td>
									<td className="p-3 text-end">
										<Button
											variant="ghost"
											size="sm"
											render={
												<Link
													to="/dashboard/organization/billing/receipt/$invoiceId"
													params={{ invoiceId: invoice.id }}
												/>
											}
										>
											<Trans>Receipt</Trans>
										</Button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</SettingsSection>
	);
}

type ReceiptProps = { invoice: InvoiceRow; planName: string | null; organizationName: string | null; locale: string };

/** One payment as a page to print. It lists what was paid for and how it is referenced, and holds no card data. */
export function Receipt({ invoice, planName, organizationName, locale }: ReceiptProps) {
	const rows: [string, string][] = [
		[t`Date`, day(invoice.date, locale)],
		[t`Amount`, formatPaid(invoice.amount, invoice.currency, locale) ?? "—"],
		[t`Method`, methodLabel(invoice)],
		[t`Reference`, invoice.reference ?? "—"],
		[t`Plan`, planName ?? invoice.planId ?? "—"],
		[t`Seats`, invoice.seats === null ? "—" : String(invoice.seats)],
		[t`Period`, periodLabel(invoice, locale)],
	];
	return (
		<article className="grid max-w-xl gap-4" data-testid="receipt">
			<h2 className="font-display text-2xl font-medium">
				<Trans>Receipt</Trans>
			</h2>
			{organizationName && <p className="text-sm text-ink-2">{organizationName}</p>}
			<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
				{rows.map(([label, value]) => (
					<div key={label} className="contents">
						<dt className="text-ink-3">{label}</dt>
						<dd className="tabular-nums">{value}</dd>
					</div>
				))}
			</dl>
			<Button className="w-fit print:hidden" onClick={() => window.print()}>
				<Trans>Print receipt</Trans>
			</Button>
		</article>
	);
}
