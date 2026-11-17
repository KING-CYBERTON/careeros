// CAREEROS (P6-T01, G10): public privacy policy page, a draft until LEGAL_PAGES_APPROVED is set.
import { t } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/features/legal/legal-page";
import { getBrand } from "@/libs/brand";

export const Route = createFileRoute("/_home/privacy")({
	component: () => <LegalPage document="privacy" />,
	head: () => ({ meta: [{ title: `${t`Privacy policy`} | ${getBrand().appName}` }] }),
});
