import { afterEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { LEGAL_PAGES_APPROVED } from "./constants";
import { legalDocuments, stripDraftBanner, type LegalDocumentId } from "./documents";
import { LegalPage } from "./legal-page";
import { SignupLegalNotice } from "./signup-notice";

function render(node: React.ReactNode) {
	const router = createRouter({
		routeTree: createRootRoute(),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	return renderToStaticMarkup(
		<RouterContextProvider router={router}>
			<I18nProvider i18n={i18n}>{node}</I18nProvider>
		</RouterContextProvider>,
	);
}

afterEach(() => {
	delete (globalThis as { __BRAND__?: unknown }).__BRAND__;
});

const pages: [LegalDocumentId, string][] = [
	["terms", "Terms of service"],
	["privacy", "Privacy policy"],
	["dpa", "Data processing addendum"],
];

describe("legal pages", () => {
	it("ship unapproved until the owner approves them", () => {
		expect(LEGAL_PAGES_APPROVED).toBe(false);
	});

	it.each(pages)("%s renders its title and the draft banner", (document, title) => {
		const html = render(<LegalPage document={document} />);
		expect(html).toContain(title);
		expect(html).toContain('data-testid="legal-draft-banner"');
		expect(html).toContain("Draft for review. Not legal advice. Not in force until approved.");
		expect(html).toContain("English only");
	});

	it.each(pages)("%s shows the banner once", (document) => {
		const html = render(<LegalPage document={document} />);
		expect(html.split("Not in force until approved").length - 1).toBe(1);
	});

	it("hides the banner once approved", () => {
		const html = render(<LegalPage document="terms" approved />);
		expect(html).not.toContain("legal-draft-banner");
	});

	it("links the terms to the licenses page", () => {
		expect(render(<LegalPage document="terms" />)).toContain('href="/licenses"');
	});

	it.each(Object.keys(legalDocuments) as LegalDocumentId[])("%s has no copied banner in its body", (document) => {
		expect(legalDocuments[document]).not.toContain("Draft for review");
	});
});

describe("stripDraftBanner", () => {
	it("removes only the block quote under the title", () => {
		expect(stripDraftBanner("# Title\n\n> a\n> b\n\nBody\n\n> keep\n")).toBe("# Title\n\nBody\n\n> keep\n");
	});

	it("leaves text without a banner alone", () => {
		expect(stripDraftBanner("# Title\n\nBody")).toBe("# Title\n\nBody");
	});
});

describe("sign-up notice", () => {
	it("links the platform's terms and privacy pages by default", () => {
		const html = render(<SignupLegalNotice />);
		expect(html).toContain("By creating an account you agree to the");
		expect(html).toMatch(/href="\/terms"[^>]*>Terms</);
		expect(html).toMatch(/href="\/privacy"[^>]*>Privacy policy</);
	});

	it("links the organization's own pages when it set them", () => {
		(globalThis as { __BRAND__?: unknown }).__BRAND__ = {
			appName: "Acme",
			termsUrl: "https://acme.example/t",
			privacyUrl: "https://acme.example/p",
		};
		const html = render(<SignupLegalNotice />);
		expect(html).toContain('href="https://acme.example/t"');
		expect(html).toContain('href="https://acme.example/p"');
		expect(html).not.toContain('href="/terms"');
	});
});
