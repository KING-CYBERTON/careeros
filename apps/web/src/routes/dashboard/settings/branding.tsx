import { createFileRoute } from "@tanstack/react-router";
import { BrandingSettings } from "@/features/branding/branding-page";

// CAREEROS (P2-T07): Settings → Branding, for owners and admins
export const Route = createFileRoute("/dashboard/settings/branding")({ component: BrandingSettings });
