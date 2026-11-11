import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { formatPaid } from "./lib";
import { SettingsSection } from "@/features/settings/section";

// CAREEROS (P3-T06, P3-T10): the payments list. Each row is an invoice (number, date, amount, method, Paid) that opens
// the invoice page (`invoice-page.tsx`). Only completed payments are recorded, so every row is Paid. Ids, amounts and
// periods only; no card data.

export type InvoiceRow = {
	id: string;
	number: string;
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
									<Trans>Invoice no.</Trans>
								</th>
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
									<Trans>Status</Trans>
								</th>
								<th className="p-3" />
							</tr>
						</thead>
						<tbody className="divide-y divide-line">
							{invoices.map((invoice) => (
								<tr key={invoice.id} data-testid="invoice-row">
									<td className="p-3 font-medium tabular-nums">{invoice.number}</td>
									<td className="p-3">{day(invoice.date, locale)}</td>
									<td className="p-3 tabular-nums">{formatPaid(invoice.amount, invoice.currency, locale) ?? "—"}</td>
									<td className="p-3">{methodLabel(invoice)}</td>
									<td className="p-3">
										<Badge variant="accent" data-testid="invoice-status">
											<Trans>Paid</Trans>
										</Badge>
									</td>
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
											<Trans>View</Trans>
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
