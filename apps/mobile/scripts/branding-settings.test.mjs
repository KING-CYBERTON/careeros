import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

// CAREEROS (P2-T07): the phone's Branding and Domains screens. The rules are pure modules and run as shipped; the
// screens are checked as source for the parity-critical wiring (who sees the rows, which endpoints they call).
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
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const utils = load(new URL("../../../packages/utils/src/brand.ts", import.meta.url));
const logic = load(new URL("../src/features/branding/logic.ts", import.meta.url));
const { brandFromPublic } = load(new URL("../src/branding/brand.ts", import.meta.url), {
	"@reactive-resume/utils/brand": utils,
});
const host = load(new URL("../src/branding/host.ts", import.meta.url), {
	"@reactive-resume/utils/brand": utils,
	"@tanstack/react-query": {},
	react: {},
	"./brand": { brandFromPublic },
	"./store": { storeBrand() {} },
});
const access = load(new URL("../src/features/branding/access.ts", import.meta.url), {
	"@tanstack/react-query": {},
	"@/api/client": {},
	"@/auth/session": {},
});

test("a picked logo must be a PNG or WebP within 512 KB, a favicon a PNG within 128 KB", () => {
	assert.equal(logic.checkAsset("logo", "image/png", 1000), "ok");
	assert.equal(logic.checkAsset("logo", "image/webp", 512 * 1024), "ok");
	assert.equal(logic.checkAsset("logo", "image/jpeg", 1000), "type");
	assert.equal(logic.checkAsset("logo", null, 1000), "type");
	assert.equal(logic.checkAsset("logo", "image/png", 512 * 1024 + 1), "size");
	assert.equal(logic.checkAsset("favicon", "image/webp", 1000), "type");
	assert.equal(logic.checkAsset("favicon", "image/png", 128 * 1024 + 1), "size");
	assert.equal(logic.assetFileName("logo", "image/webp"), "logo.webp");
	assert.equal(logic.assetFileName("favicon", "image/png"), "favicon.png");
});

test("domain records show only while DNS work is left, and rechecks stop for failed or removing domains", () => {
	for (const [status, records, recheck] of [
		["pending", true, true],
		["verified", true, true],
		["active", false, true],
		["failed", false, false],
		["removing", false, false],
	]) {
		assert.equal(logic.needsRecords(status), records, status);
		assert.equal(logic.canRecheck(status), recheck, status);
	}
	assert.equal(logic.errorCode({ code: "TOO_MANY_REQUESTS" }), "TOO_MANY_REQUESTS");
	assert.equal(logic.errorCode(new Error("x")), undefined);
});

test("the admin gate follows the owner-or-admin call: loading, allowed, denied", () => {
	assert.equal(access.adminStatus({ isPending: true, isSuccess: false }), "loading");
	assert.equal(access.adminStatus({ isPending: false, isSuccess: true }), "allowed");
	assert.equal(access.adminStatus({ isPending: false, isSuccess: false }), "denied");
});

test("the host lookup brands the sign-in screen, and the platform default clears it", () => {
	const server = "https://acme.careers.example";
	const org = brandFromPublicHost({ organizationId: "org_acme", appName: "Acme Careers", primaryColor: "#1A56DB" });
	assert.equal(org.appName, "Acme Careers");
	assert.equal(org.primaryColor, "#1a56db");
	const platform = host.brandFromHostBranding({ organizationId: null, appName: null, logoUrl: null }, server);
	assert.deepEqual(platform, utils.DEFAULT_BRAND);
	function brandFromPublicHost(data) {
		return host.brandFromHostBranding(data, server);
	}
});

test("the host lookup reads GET /branding/host without a session and keeps the stored brand when it fails", async () => {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push([url, init?.headers]);
		return { ok: true, json: async () => ({ organizationId: "o", appName: "Acme" }) };
	};
	assert.deepEqual(await host.fetchHostBranding("https://acme.careers.example"), {
		organizationId: "o",
		appName: "Acme",
	});
	assert.equal(calls[0][0], "https://acme.careers.example/api/openapi/branding/host");
	assert.ok(!("authorization" in (calls[0][1] ?? {})));
	globalThis.fetch = async () => {
		throw new Error("offline");
	};
	assert.equal(await host.fetchHostBranding("https://acme.careers.example"), null);
	globalThis.fetch = async () => ({ ok: false });
	assert.equal(await host.fetchHostBranding("https://acme.careers.example"), null);
});

test("the settings screen shows Branding and Domains only to owners and admins, and the screens call the shared API", () => {
	const index = source("../app/(tabs)/settings/index.tsx");
	assert.match(index, /useOrganizationAdmin\(\) === "allowed"/);
	assert.match(index, /canManageBrand \? \(/);
	assert.match(index, /routes\.settings\("branding"\)/);
	assert.match(index, /routes\.settings\("domains"\)/);
	assert.match(source("../src/routes.ts"), /"branding" \| "domains"/);

	const branding = source("../src/features/branding/branding-screen.tsx");
	for (const call of [
		"client.branding.update",
		"client.branding.deleteLogo",
		"client.branding.deleteFavicon",
		"/branding/${kind}",
	])
		assert.ok(branding.includes(call), call);
	assert.match(branding, /useOrganizationAdmin/);
	assert.match(branding, /primaryOnWhite/);
	assert.match(branding, /This colour may be hard to see on a white background\./);
	const domains = source("../src/features/branding/domains-screen.tsx");
	for (const call of [
		"client.organizationDomain.add",
		"client.organizationDomain.recheck",
		"client.organizationDomain.remove",
		"organizationDomain.info",
	])
		assert.ok(domains.includes(call), call);
	// Organization ids never come from the phone.
	for (const text of [branding, domains]) assert.doesNotMatch(text, /organizationId/);
	assert.match(source("../app/(tabs)/settings/branding.tsx"), /BrandingScreen/);
	assert.match(source("../app/(tabs)/settings/domains.tsx"), /DomainsScreen/);
	assert.match(source("../app/(auth)/sign-in.tsx"), /useHostBranding\(server\)/);
});
