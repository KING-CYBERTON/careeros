import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

// CAREEROS (P2-T02, D10): the phone turns the API's public branding into a brand, dropping what is not valid.
const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const { transformSync } = createRequire(serverRequire.resolve("tsx"))("esbuild");

function load(url, mocks = {}) {
	const module = { exports: {} };
	const code = transformSync(readFileSync(url, "utf8"), { loader: "ts", format: "cjs" }).code;
	new Function("require", "module", "exports", code)(
		(name) => {
			assert.ok(name in mocks, `Unexpected dependency: ${name}`);
			return mocks[name];
		},
		module,
		module.exports,
	);
	return module.exports;
}

const utils = load(new URL("../../../packages/utils/src/brand.ts", import.meta.url));
const { brandFromPublic } = load(new URL("../src/branding/brand.ts", import.meta.url), {
	"@reactive-resume/utils/brand": utils,
});

const server = "https://acme.careers.example";
const LOGO = "logo-123e4567-e89b-12d3-a456-426614174000.png";

test("keeps a complete, valid branding", () => {
	const brand = brandFromPublic(
		{
			appName: "  Acme Careers ",
			logoUrl: `https://careers.example/api/branding-assets/org_acme/${LOGO}`,
			primaryColor: "#1A56DB",
			supportUrl: "https://acme.example/help",
			privacyUrl: "https://acme.example/privacy",
		},
		server,
	);
	assert.deepEqual(brand, {
		appName: "Acme Careers",
		logoUrl: `https://careers.example/api/branding-assets/org_acme/${LOGO}`,
		supportUrl: "https://acme.example/help",
		privacyUrl: "https://acme.example/privacy",
		primaryColor: "#1a56db",
	});
});

test("falls back to the platform name and drops anything invalid or not drawable", () => {
	const brand = brandFromPublic(
		{
			appName: null,
			logoUrl: "https://evil.example/logo.png",
			primaryColor: "red",
			supportUrl: "http://acme.example",
			termsUrl: "javascript:alert(1)",
			privacyUrl: "https://user:pw@acme.example",
		},
		server,
	);
	assert.deepEqual(brand, { appName: utils.PLATFORM_DEFAULT_APP_NAME });
});

test("does not use an SVG logo (Image cannot draw it)", () => {
	const svg = "logo-123e4567-e89b-12d3-a456-426614174000.svg";
	assert.equal(
		brandFromPublic({ appName: "A", logoUrl: `/api/branding-assets/org_a/${svg}` }, server).logoUrl,
		undefined,
	);
});

test("resolves a relative logo address against the server", () => {
	assert.equal(
		brandFromPublic({ appName: "A", logoUrl: `/api/branding-assets/org_a/${LOGO}` }, server).logoUrl,
		`${server}/api/branding-assets/org_a/${LOGO}`,
	);
});

test("caps a long name", () => {
	assert.equal(brandFromPublic({ appName: "x".repeat(200) }, server).appName.length, 60);
});
