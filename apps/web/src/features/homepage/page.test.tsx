import { expect, it } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { Homepage } from "./page";
import { ThemeProvider } from "@/features/theme/provider";

it("offers Sign in and Create account as plain links", () => {
	const router = createRouter({
		routeTree: createRootRoute(),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	i18n.loadAndActivate({ locale: "en-US", messages: {} });

	const html = renderToStaticMarkup(
		<RouterContextProvider router={router}>
			<I18nProvider i18n={i18n}>
				<ThemeProvider theme="light">
					<Homepage />
				</ThemeProvider>
			</I18nProvider>
		</RouterContextProvider>,
	);

	expect(html).toMatch(/<a(?![^>]*role=)[^>]*href="\/auth\/login"[^>]*>Sign in<\/a>/);
	expect(html).toMatch(/<a(?![^>]*role=)[^>]*href="\/auth\/register"[^>]*>Create account<\/a>/);
	expect(html).toMatch(/<h1[^>]*>CareerOS<\/h1>/);
});
