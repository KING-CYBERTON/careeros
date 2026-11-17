import { createFileRoute } from "@tanstack/react-router";
import { AnalyticsSettings } from "@/features/org-admin/analytics-page";

// CAREEROS (P3-T08): Settings → Analytics, for owners and admins of an organization
export const Route = createFileRoute("/dashboard/settings/analytics")({ component: AnalyticsSettings });
