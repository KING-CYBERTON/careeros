import { describe, expect, it } from "vite-plus/test";
import { LEGAL_PAGE_PATHS, resolveLegalLinks } from "./legal-links";

describe("resolveLegalLinks", () => {
	it("uses the organization's own pages when it set them", () => {
		const links = resolveLegalLinks({
			termsUrl: "https://acme.example/terms",
			privacyUrl: "https://acme.example/privacy",
		});
		expect(links.terms).toEqual({ href: "https://acme.example/terms", external: true, platform: false });
		expect(links.privacy).toEqual({ href: "https://acme.example/privacy", external: true, platform: false });
	});

	it("falls back to the platform pages when nothing is set", () => {
		const links = resolveLegalLinks({});
		expect(links.terms).toEqual({ href: "/terms", external: false, platform: true });
		expect(links.privacy).toEqual({ href: "/privacy", external: false, platform: true });
		expect(resolveLegalLinks(null).terms.href).toBe(LEGAL_PAGE_PATHS.terms);
	});

	it("decides each link on its own", () => {
		const links = resolveLegalLinks({ privacyUrl: "https://acme.example/privacy" });
		expect(links.terms.platform).toBe(true);
		expect(links.privacy.platform).toBe(false);
	});

	it("treats blank values as unset", () => {
		const links = resolveLegalLinks({ termsUrl: "  ", privacyUrl: "" });
		expect(links.terms.platform).toBe(true);
		expect(links.privacy.platform).toBe(true);
	});

	it("builds absolute platform links from a server origin", () => {
		const links = resolveLegalLinks({}, "https://careeros.example/");
		expect(links.terms).toEqual({ href: "https://careeros.example/terms", external: true, platform: true });
		expect(links.privacy.href).toBe("https://careeros.example/privacy");
	});

	it("still prefers the organization's page when an origin is given", () => {
		const links = resolveLegalLinks({ termsUrl: "https://acme.example/t" }, "https://careeros.example");
		expect(links.terms.href).toBe("https://acme.example/t");
		expect(links.privacy.href).toBe("https://careeros.example/privacy");
	});
});
