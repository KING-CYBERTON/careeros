import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Alert, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { Receipt } from "./invoices";
import { useBilling, useInvoices } from "./queries";
import { PageHeader } from "@/components/layout/page-header";

// CAREEROS (P3-T06): one payment as a printable page. The sidebar and buttons are hidden when printing.

type ReceiptPageProps = { invoiceId: string };

export function ReceiptPage({ invoiceId }: ReceiptPageProps) {
	const { i18n } = useLingui();
	const billing = useBilling();
	const invoices = useInvoices();
	const invoice = invoices.data?.invoices.find((entry) => entry.id === invoiceId);
	const planName = billing.data?.plans.find((plan) => plan.id === invoice?.planId)?.name ?? null;
	return (
		<div className="mx-auto grid w-full max-w-[720px] content-start gap-6 px-6 pt-8 pb-16 max-sm:px-4">
			<div className="print:hidden">
				<PageHeader
					title={<Trans>Receipt</Trans>}
					back={
						<Link to="/dashboard/organization/billing" className="text-sm text-ink-2 underline">
							<Trans>Back to billing</Trans>
						</Link>
					}
				/>
			</div>
			{invoices.isPending ? (
				<Skeleton className="h-40 rounded-xl" />
			) : invoice ? (
				<Receipt invoice={invoice} planName={planName} organizationName={null} locale={i18n.locale} />
			) : (
				<Alert data-testid="receipt-missing">
					<AlertTitle>{t`This receipt was not found`}</AlertTitle>
				</Alert>
			)}
		</div>
	);
}
