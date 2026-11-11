import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Alert, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { toast } from "@reactive-resume/ui/components/toast";
import { downloadWithAnchor } from "@reactive-resume/utils/file";
import { InvoiceSheet } from "./invoice-sheet";
import { useInvoice } from "./queries";
import { PageHeader } from "@/components/layout/page-header";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P3-T06, P3-T10): one payment as an invoice. The page shows the sheet on screen, offers Download invoice (the
// PDF the server renders) and Print, and prints as a clean A4 page: everything but the sheet is hidden when printing.
// The route keeps its old address (`.../billing/receipt/$invoiceId`) so existing links still work.

// `visibility` rather than `display` so the sheet keeps its place in the layout while the rest of the app (sidebar,
// header, buttons) disappears; the sheet is then lifted to the top of the page.
const PRINT_CSS = `
@page { size: A4; margin: 18mm; }
@media print {
	html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
	body * { visibility: hidden !important; }
	.invoice-print, .invoice-print * { visibility: visible !important; }
	.invoice-print { position: absolute; inset-inline: 0; top: 0; }
}
`;

type ReceiptPageProps = { invoiceId: string };

export function ReceiptPage({ invoiceId }: ReceiptPageProps) {
	const { i18n } = useLingui();
	const invoice = useInvoice(invoiceId);
	const download = useMutation(
		orpc.billing.invoicePdf.mutationOptions({
			onError: (error) =>
				toast.add({ type: "error", description: getReadableErrorMessage(error, t`Couldn't download the invoice.`) }),
		}),
	);
	const onDownload = async () => {
		const number = invoice.data?.number;
		if (!number) return;
		const file = await download.mutateAsync({ id: invoiceId }).catch(() => null);
		if (file) downloadWithAnchor(file.body, `${number}.pdf`);
	};
	const notFound = (invoice.error as { code?: string } | null)?.code === "NOT_FOUND";
	return (
		<div className="mx-auto grid w-full max-w-[960px] content-start gap-6 px-6 pt-8 pb-16 max-sm:px-4">
			<style>{PRINT_CSS}</style>
			<div className="grid gap-6 print:hidden">
				<PageHeader
					title={<Trans>Invoice</Trans>}
					back={
						<Link to="/dashboard/organization/billing" className="text-sm text-ink-2 underline">
							<Trans>Back to billing</Trans>
						</Link>
					}
					actions={
						invoice.data ? (
							<>
								<Button variant="secondary" disabled={download.isPending} onClick={() => void onDownload()}>
									{download.isPending ? <Spinner decorative /> : <Icon name="download-simple" />}
									<Trans>Download invoice</Trans>
								</Button>
								<Button variant="ghost" onClick={() => window.print()}>
									<Icon name="printer" />
									<Trans>Print</Trans>
								</Button>
							</>
						) : undefined
					}
				/>
			</div>
			{invoice.isPending ? (
				<Skeleton className="mx-auto h-96 w-full max-w-[210mm] rounded-lg" />
			) : invoice.data ? (
				<div className="invoice-print">
					<InvoiceSheet invoice={invoice.data} locale={i18n.locale} />
				</div>
			) : (
				<Alert data-testid="receipt-missing">
					<AlertTitle>{notFound ? t`This invoice was not found` : t`Couldn't load this invoice`}</AlertTitle>
				</Alert>
			)}
		</div>
	);
}
