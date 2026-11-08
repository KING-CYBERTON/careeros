import { createFileRoute } from "@tanstack/react-router";
import { CohortsSettings } from "@/features/org-admin/cohorts-page";

// CAREEROS (P3-T08): Settings → Cohorts, for owners and admins of an organization
export const Route = createFileRoute("/dashboard/settings/cohorts")({ component: CohortsSettings });
