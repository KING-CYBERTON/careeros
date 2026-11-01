import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";
// CAREEROS (P2-T02): the page for an address that names no organization
import { UnknownOrganizationScreen } from "./components/layout/unknown-organization-screen";
import { getLocale, loadLocale } from "./libs/locale";
import { followReducedMotion } from "./libs/motion";
import { isUnknownOrganization } from "./libs/org-not-found";
import { getRouter } from "./router";
import "./index.css";

const rootElement = document.getElementById("app");
if (!rootElement) throw new Error("Root element not found");

followReducedMotion();

// CAREEROS (P2-T02): on an address that names no organization the API answers 404 to everything, so the app does not
// start; the neutral "not set up yet" page stands in for it.
if (isUnknownOrganization()) {
	await loadLocale(getLocale());
	ReactDOM.createRoot(rootElement).render(
		<I18nProvider i18n={i18n}>
			<UnknownOrganizationScreen />
		</I18nProvider>,
	);
} else {
	const router = await getRouter();

	// The router owns the title, description and robots tags from here on (see libs/seo.ts), so the copies in the served
	// HTML go; everything else the server wrote into <head> (canonical, hreflang, social cards, structured data) stays.
	document.head.querySelectorAll('title, meta[name="description"], meta[name="robots"]').forEach((element) => {
		element.remove();
	});

	// The server may send the homepage prerendered into #app. React replaces it on its first render, so that render waits
	// for the route to load; otherwise the prerendered page would give way to a loading screen before coming back.
	if (rootElement.hasChildNodes()) await router.load();

	ReactDOM.createRoot(rootElement).render(<RouterProvider router={router} />);
}
