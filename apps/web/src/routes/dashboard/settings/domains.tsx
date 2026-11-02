import { createFileRoute } from "@tanstack/react-router";
import { DomainsSettings } from "@/features/branding/domains-page";

// CAREEROS (P2-T07): Settings → Domains, for owners and admins
export const Route = createFileRoute("/dashboard/settings/domains")({ component: DomainsSettings });
