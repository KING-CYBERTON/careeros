// CAREEROS (P6-T01, G10): public terms of service page, a draft until LEGAL_PAGES_APPROVED is set.
import { t } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/features/legal/legal-page";
import { getBrand } from "@/libs/brand";

export const Route = createFileRoute("/_home/terms")({
	component: () => <LegalPage document="terms" />,
	head: () => ({ meta: [{ title: `${t`Terms of service`} | ${getBrand().appName}` }] }),
});
