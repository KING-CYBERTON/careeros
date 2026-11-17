import { createFileRoute } from "@tanstack/react-router";
import { EmailTemplatesSettings } from "@/features/email-templates/my-templates-page";

// CAREEROS (P5-T04): Settings → Email templates, for every member
export const Route = createFileRoute("/dashboard/settings/email-templates")({ component: EmailTemplatesSettings });
