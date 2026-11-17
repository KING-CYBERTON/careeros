import { createFileRoute } from "@tanstack/react-router";
import { EmailPage } from "@/features/platform-admin/email-page";

// CAREEROS (P6-T02)
export const Route = createFileRoute("/admin/email")({ component: EmailPage });
