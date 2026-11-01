import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { render } from "react-email";
import { InvitationEmail, ResetPasswordEmail, VerifyEmail, VerifyEmailChange } from "./auth";

// P2-T04: every template renders with no brand (the platform default) and with a full brand.
const url = "https://acme.example.com/api/auth/verify-email?token=tok_123";
const fullBrand = {
	appName: "Acme Careers",
	logoUrl: "https://acme.example.com/api/branding-assets/org1/logo-11111111-1111-1111-1111-111111111111.png",
	primaryColor: "#112233",
	primaryForeground: "#ffffff",
	supportUrl: "https://acme.example.com/support",
	privacyUrl: "https://acme.example.com/privacy",
	termsUrl: "https://acme.example.com/terms",
};

const templates = {
	reset: (brand?: Parameters<typeof ResetPasswordEmail>[0]["brand"]) =>
		createElement(ResetPasswordEmail, { url, brand }),
	verify: (brand?: Parameters<typeof VerifyEmail>[0]["brand"]) => createElement(VerifyEmail, { url, brand }),
	change: (brand?: Parameters<typeof VerifyEmailChange>[0]["brand"]) =>
		createElement(VerifyEmailChange, { url, previousEmail: "a@example.com", newEmail: "b@example.com", brand }),
	invite: (brand?: Parameters<typeof InvitationEmail>[0]["brand"]) =>
		createElement(InvitationEmail, { url, organizationName: "Org", inviterName: "Ines", brand }),
};

describe.each(Object.entries(templates))("%s email", (_name, make) => {
	it("renders with no brand as the platform default", async () => {
		const html = await render(make());
		expect(html).toContain("CareerOS");
		expect(html).toContain(url.replaceAll("&", "&amp;"));
		expect(html).not.toContain("<img");
		expect(html).not.toContain("Support");
	});

	it("renders a full brand: logo, button colours, footer links and the app name", async () => {
		const html = await render(make(fullBrand));
		expect(html).toContain("Acme Careers");
		expect(html).not.toContain("CareerOS");
		expect(html).toContain(fullBrand.logoUrl);
		expect(html).toMatch(/background-color:\s*#112233/i);
		expect(html).toMatch(/color:\s*#ffffff/i);
		for (const link of [fullBrand.supportUrl, fullBrand.privacyUrl, fullBrand.termsUrl]) expect(html).toContain(link);
	});

	it("uses the app name as text when the logo is an SVG or WebP", async () => {
		for (const ext of ["svg", "webp"]) {
			const html = await render(
				make({ appName: "Acme Careers", logoUrl: fullBrand.logoUrl.replace(".png", `.${ext}`) }),
			);
			expect(html).not.toContain("<img");
			expect(html).toContain("Acme Careers");
		}
	});

	it("escapes an app name that carries markup, quotes or line breaks", async () => {
		const html = await render(make({ appName: '<script>alert("x")</script>\r\nBcc: a@b.c' }));
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toMatch(/[\r\n]\s*Bcc/);
	});

	it("drops a colour or link that is not valid instead of rendering it", async () => {
		const html = await render(
			make({
				appName: "Acme",
				primaryColor: "red; background:url(https://evil.example)",
				supportUrl: "javascript:alert(1)",
				privacyUrl: "http://insecure.example",
				logoUrl: "javascript:alert(1).png",
			}),
		);
		expect(html).not.toContain("evil.example");
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("insecure.example");
		expect(html).not.toContain("<img");
	});
});

describe("button text colour", () => {
	it("falls back to a readable colour when only the primary colour is given", async () => {
		const light = await render(createElement(VerifyEmail, { url, brand: { appName: "A", primaryColor: "#ffff00" } }));
		expect(light).toMatch(/color:\s*#000000/i);
		const dark = await render(createElement(VerifyEmail, { url, brand: { appName: "A", primaryColor: "#000080" } }));
		expect(dark).toMatch(/color:\s*#ffffff/i);
	});
});
