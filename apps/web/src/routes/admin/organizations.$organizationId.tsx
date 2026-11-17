import { createFileRoute } from "@tanstack/react-router";
import { OrganizationPage } from "@/features/platform-admin/organization-page";

export const Route = createFileRoute("/admin/organizations/$organizationId")({ component: RouteComponent });

function RouteComponent() {
	const { organizationId } = Route.useParams();
	return <OrganizationPage key={organizationId} organizationId={organizationId} />;
}
