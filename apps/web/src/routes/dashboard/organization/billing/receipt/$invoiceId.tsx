import { createFileRoute } from "@tanstack/react-router";
import { ReceiptPage } from "@/features/billing/receipt-page";

// CAREEROS (P3-T06): one payment as a printable receipt
export const Route = createFileRoute("/dashboard/organization/billing/receipt/$invoiceId")({
	component: RouteComponent,
});

function RouteComponent() {
	const { invoiceId } = Route.useParams();
	return <ReceiptPage invoiceId={invoiceId} />;
}
