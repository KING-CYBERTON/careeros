import { afterEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingFooter } from "./footer";

function renderFooter() {
	const router = createRouter({
		routeTree: createRootRoute(),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	i18n.loadAndActivate({ locale: "en-US", messages: {} });

	return renderToStaticMarkup(
		<RouterContextProvider router={router}>
			<I18nProvider i18n={i18n}>
				<LandingFooter />
			</I18nProvider>
		</RouterContextProvider>,
	);
}

afterEach(() => {
	delete (globalThis as { __BRAND__?: unknown }).__BRAND__;
});

it("links to the open-source licenses page and names the platform default brand", () => {
	const html = renderFooter();

	expect(html).toMatch(/<a[^>]*href="\/licenses"[^>]*>Open-source licenses<\/a>/);
	expect(html).toContain("CareerOS");
	expect(html).not.toMatch(/Reactive Resume|rxresu/i);
});

// CAREEROS (P6-T01): the legal links are the organization's own when set, else the platform's pages.
describe("legal links", () => {
	it("point to the platform's terms, privacy and DPA pages when the brand sets none", () => {
		const html = renderFooter();
		expect(html).toMatch(/<a[^>]*href="\/terms"[^>]*>Terms of service<\/a>/);
		expect(html).toMatch(/<a[^>]*href="\/privacy"[^>]*>Privacy policy<\/a>/);
		expect(html).toMatch(/<a[^>]*href="\/dpa"[^>]*>Data processing addendum<\/a>/);
	});

	it("use the organization's own pages when it set them, and leave out the DPA", () => {
		(globalThis as { __BRAND__?: unknown }).__BRAND__ = {
			appName: "Acme Careers",
			termsUrl: "https://acme.example/terms",
			privacyUrl: "https://acme.example/privacy",
		};
		const html = renderFooter();
		expect(html).toMatch(/<a[^>]*href="https:\/\/acme.example\/terms"[^>]*>Terms of service<\/a>/);
		expect(html).toMatch(/<a[^>]*href="https:\/\/acme.example\/privacy"[^>]*>Privacy policy<\/a>/);
		expect(html).not.toContain('href="/terms"');
		expect(html).not.toContain("Data processing addendum");
	});

	it("fill only the page the organization did not set", () => {
		(globalThis as { __BRAND__?: unknown }).__BRAND__ = {
			appName: "Acme Careers",
			privacyUrl: "https://acme.example/privacy",
		};
		const html = renderFooter();
		expect(html).toMatch(/<a[^>]*href="\/terms"[^>]*>Terms of service<\/a>/);
		expect(html).toMatch(/<a[^>]*href="https:\/\/acme.example\/privacy"[^>]*>Privacy policy<\/a>/);
	});
});
