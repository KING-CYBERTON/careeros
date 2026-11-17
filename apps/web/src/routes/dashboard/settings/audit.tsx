import { createFileRoute } from "@tanstack/react-router";
import { AuditSettings } from "@/features/org-admin/audit-page";

// CAREEROS (P3-T08): Settings → Audit log, for owners and admins of an organization
export const Route = createFileRoute("/dashboard/settings/audit")({ component: AuditSettings });
