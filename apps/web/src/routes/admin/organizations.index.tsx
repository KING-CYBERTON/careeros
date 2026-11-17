import { createFileRoute } from "@tanstack/react-router";
import { OrganizationsPage } from "@/features/platform-admin/organizations-page";

export const Route = createFileRoute("/admin/organizations/")({ component: OrganizationsPage });
