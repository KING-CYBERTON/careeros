import { createFileRoute } from "@tanstack/react-router";
import { AuditPage } from "@/features/platform-admin/audit-page";

export const Route = createFileRoute("/admin/audit")({ component: AuditPage });
