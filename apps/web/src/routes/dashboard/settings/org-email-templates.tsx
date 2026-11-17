import { createFileRoute } from "@tanstack/react-router";
import { OrgEmailTemplatesSettings } from "@/features/email-templates/org-templates-page";

// CAREEROS (P5-T04): Org admin console → Email templates, for owners and admins of an organization
export const Route = createFileRoute("/dashboard/settings/org-email-templates")({
	component: OrgEmailTemplatesSettings,
});
