import { describe, expect, it } from "vite-plus/test";
import { renderWebPageDocument, socialMetaTags, webPageMessages } from "./document";

const page = { html: "<p>resume</p>", css: "", lang: "en-US" };

// CAREEROS: the web page credit and site name come from the app name, defaulting to the platform name (P2-T08).
describe("web page branding", () => {
	it("credits the platform default and links nothing upstream", () => {
		const html = renderWebPageDocument({
			page,
			messages: webPageMessages("en-US"),
			creditUrl: "https://example.com",
		});
		expect(html).toContain("Made with CareerOS");
		expect(html).toContain('<span aria-hidden="true">CareerOS</span>');
		expect(html).not.toMatch(/reactive resume|rxresu/i);
	});

	it("uses a given app name in the credit and the site name", () => {
		const html = renderWebPageDocument({
			page,
			messages: webPageMessages("en-US", "Acme Careers"),
			creditUrl: "https://acme.test",
			appName: "Acme Careers",
			head: { title: "A", description: "B", canonicalUrl: "https://acme.test/a", indexable: true },
		});
		expect(html).toContain("Made with Acme Careers");
		expect(html).toContain('<meta property="og:site_name" content="Acme Careers">');
	});

	it("defaults og:site_name to the platform name", () => {
		expect(socialMetaTags({ type: "website", title: "t", description: "d", url: "u" })).toContain(
			'<meta property="og:site_name" content="CareerOS">',
		);
	});
});
