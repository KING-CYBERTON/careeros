import { createFileRoute } from "@tanstack/react-router";
import { OrganizationAccessPage } from "@/features/auth/pages/organization-access";

// CAREEROS: the join or switch page of an organization's own address (P2-T03)
export const Route = createFileRoute("/auth/organization-access")({
	component: OrganizationAccessPage,
});
