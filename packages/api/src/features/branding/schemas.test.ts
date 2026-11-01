import { describe, expect, it } from "vite-plus/test";
import { BRANDING_FONTS } from "@reactive-resume/db/schema";
import { brandingUpdateSchema, isHttpsUrl, settingsUpdateSchema } from "./schemas";

const parses = (input: unknown) => brandingUpdateSchema.safeParse(input).success;

describe("brandingUpdateSchema", () => {
	it("accepts a full valid update and a partial one", () => {
		expect(
			parses({
				appName: "Acme Careers",
				primaryColor: "#1A2b3C",
				secondaryColor: "#000000",
				font: "Inter",
				emailFromName: "Acme Career Office",
				supportUrl: "https://acme.example/support",
				termsUrl: "https://acme.example/terms",
				privacyUrl: "https://acme.example/privacy",
			}),
		).toBe(true);
		expect(parses({})).toBe(true);
		expect(parses({ primaryColor: null, font: null, appName: null })).toBe(true);
	});

	it.each(["red", "#fff", "#12345", "#1234567", "1a2b3c", "#gggggg", " #1a2b3c"])("rejects the colour %j", (color) => {
		expect(parses({ primaryColor: color })).toBe(false);
		expect(parses({ secondaryColor: color })).toBe(false);
	});

	it("accepts only the listed fonts", () => {
		for (const font of BRANDING_FONTS) expect(parses({ font })).toBe(true);
		expect(parses({ font: "Comic Sans MS" })).toBe(false);
		expect(parses({ font: "inter" })).toBe(false);
	});

	it.each([
		"http://acme.example",
		"ftp://acme.example",
		"javascript:alert(1)",
		"//acme.example",
		"acme.example",
		"https://user:pass@acme.example",
		"https://",
		"HTTPS://acme.example",
		` https://acme.example`,
	])("rejects the link %j", (url) => {
		expect(parses({ supportUrl: url })).toBe(false);
		expect(parses({ termsUrl: url })).toBe(false);
		expect(parses({ privacyUrl: url })).toBe(false);
	});

	it("rejects empty and over-long names and sender names with line breaks or angle brackets", () => {
		expect(parses({ appName: "" })).toBe(false);
		expect(parses({ appName: "x".repeat(61) })).toBe(false);
		expect(parses({ emailFromName: "Acme\r\nBcc: someone@example.test" })).toBe(false);
		expect(parses({ emailFromName: "Acme <ceo@acme.example>" })).toBe(false);
	});

	it("keeps every listed font inside the database CHECK list", () => {
		expect(new Set(BRANDING_FONTS).size).toBe(BRANDING_FONTS.length);
		expect(BRANDING_FONTS.length).toBeGreaterThanOrEqual(6);
		expect(BRANDING_FONTS.length).toBeLessThanOrEqual(10);
	});
});

describe("isHttpsUrl", () => {
	it("needs https and a host", () => {
		expect(isHttpsUrl("https://acme.example/a?b=1#c")).toBe(true);
		expect(isHttpsUrl("http://acme.example")).toBe(false);
	});
});

describe("settingsUpdateSchema", () => {
	it("takes an optional boolean", () => {
		expect(settingsUpdateSchema.safeParse({ openSignup: true }).success).toBe(true);
		expect(settingsUpdateSchema.safeParse({}).success).toBe(true);
		expect(settingsUpdateSchema.safeParse({ openSignup: "yes" }).success).toBe(false);
	});
});
