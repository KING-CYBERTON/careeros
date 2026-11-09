import { createFileRoute } from "@tanstack/react-router";
import { BillingReturn } from "@/features/billing/return-page";

// CAREEROS (P3-T06): where the payment provider sends the customer back; waits for the plan to change
export const Route = createFileRoute("/dashboard/organization/billing/return")({
	validateSearch: (search: Record<string, unknown>): { billing?: string } =>
		typeof search.billing === "string" ? { billing: search.billing } : {},
	component: RouteComponent,
});

function RouteComponent() {
	const { billing } = Route.useSearch();
	return <BillingReturn result={billing} />;
}
