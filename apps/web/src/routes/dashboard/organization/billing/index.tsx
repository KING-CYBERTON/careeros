import { createFileRoute } from "@tanstack/react-router";
import { BillingPage } from "@/features/billing/billing-page";

// CAREEROS (P3-T06): the organization billing page for owners and admins
export const Route = createFileRoute("/dashboard/organization/billing/")({ component: BillingPage });
