import { createFileRoute } from "@tanstack/react-router";
import { AiUsageSettings } from "@/features/org-admin/ai-usage-page";

// CAREEROS (P3-T08): Settings → AI usage, the quota view for owners and admins of an organization
export const Route = createFileRoute("/dashboard/settings/ai-usage")({ component: AiUsageSettings });
