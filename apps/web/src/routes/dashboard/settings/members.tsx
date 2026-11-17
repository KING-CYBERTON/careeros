import { createFileRoute } from "@tanstack/react-router";
import { MembersSettings } from "@/features/organization/members-page";

// CAREEROS: Members & invites (P1-T03)
export const Route = createFileRoute("/dashboard/settings/members")({ component: MembersSettings });
