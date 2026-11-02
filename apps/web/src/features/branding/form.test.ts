import { describe, expect, it } from "vite-plus/test";
import { buildPatch, formFromBranding, validateForm, type BrandingData } from "./form";

const empty: BrandingData = {
	appName: null,
	primaryColor: null,
	secondaryColor: null,
	font: null,
	emailFromName: null,
	emailReplyTo: null,
	supportUrl: null,
	termsUrl: null,
	privacyUrl: null,
};

describe("validateForm", () => {
	it("accepts an empty form and a complete valid one", () => {
		expect(validateForm(formFromBranding(empty))).toEqual({});
		expect(
			validateForm({
				appName: "Acme Careers",
				primaryColor: "#1A56DB",
				secondaryColor: "#ffcc00",
				font: "Inter",
				emailFromName: "Acme Career Office",
				emailReplyTo: "help@acme.example",
				supportUrl: "https://acme.example/help",
				termsUrl: "https://acme.example/terms",
				privacyUrl: "https://acme.example/privacy",
			}),
		).toEqual({});
	});

	it("rejects colours that are not #rrggbb", () => {
		for (const value of ["red", "#abc", "1a56db", "#1a56dbff", "#1a56d;"])
			expect(validateForm({ ...formFromBranding(empty), primaryColor: value }).primaryColor).toBe("color");
		expect(validateForm({ ...formFromBranding(empty), secondaryColor: "nope" }).secondaryColor).toBe("color");
	});

	it("rejects links that are not plain https", () => {
		for (const value of ["http://acme.example", "javascript:alert(1)", "https://u:p@acme.example", "acme.example"])
			expect(validateForm({ ...formFromBranding(empty), supportUrl: value }).supportUrl).toBe("url");
	});

	it("rejects a long name, a font outside the list, and an address that is not one bare address", () => {
		const base = formFromBranding(empty);
		expect(validateForm({ ...base, appName: "x".repeat(61) }).appName).toBe("name-too-long");
		expect(validateForm({ ...base, font: "Comic Sans" }).font).toBe("font");
		expect(validateForm({ ...base, emailReplyTo: "A <a@b.example>" }).emailReplyTo).toBe("email");
		expect(validateForm({ ...base, emailFromName: "Acme <x>" }).emailFromName).toBe("sender");
	});
});

describe("buildPatch", () => {
	it("sends only the fields that changed, and null for an emptied one", () => {
		const stored: BrandingData = { ...empty, appName: "Acme", primaryColor: "#1a56db" };
		const form = { ...formFromBranding(stored), appName: "  Acme Co ", primaryColor: "", secondaryColor: "#FFCC00" };
		expect(buildPatch(form, stored)).toEqual({ appName: "Acme Co", primaryColor: null, secondaryColor: "#ffcc00" });
		expect(buildPatch(formFromBranding(stored), stored)).toEqual({});
	});
});
