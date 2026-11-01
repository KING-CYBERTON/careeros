import { expect, it } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingFooter } from "./footer";

it("links to the open-source licenses page and names the platform default brand", () => {
	const router = createRouter({
		routeTree: createRootRoute(),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	i18n.loadAndActivate({ locale: "en-US", messages: {} });

	const html = renderToStaticMarkup(
		<RouterContextProvider router={router}>
			<I18nProvider i18n={i18n}>
				<LandingFooter />
			</I18nProvider>
		</RouterContextProvider>,
	);

	expect(html).toMatch(/<a[^>]*href="\/licenses"[^>]*>Open-source licenses<\/a>/);
	expect(html).toContain("CareerOS");
	expect(html).not.toMatch(/Reactive Resume|rxresu/i);
});
