// CAREEROS (P6-T01, G10): public data processing addendum page, a draft until LEGAL_PAGES_APPROVED is set.
import { t } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/features/legal/legal-page";
import { getBrand } from "@/libs/brand";

export const Route = createFileRoute("/_home/dpa")({
	component: () => <LegalPage document="dpa" />,
	head: () => ({ meta: [{ title: `${t`Data processing addendum`} | ${getBrand().appName}` }] }),
});
