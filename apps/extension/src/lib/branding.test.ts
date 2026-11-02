import { describe, expect, it, vi } from "vite-plus/test";
import { BRANDING_PATH, fetchHostBranding, parseHostBranding, sameOriginLogo } from "./branding";

const ORIGIN = "https://careers.example.org";

/** The answer a CareerOS server gives for an organization's address (P2-T07). */
const answer = (overrides: Record<string, unknown> = {}) => ({
	organizationId: "org_1",
	slug: "acme",
	appName: "Acme Careers",
	logoUrl: "/api/branding-assets/org_1/logo-0c8c3d5a-7f0e-4a4e-9b86-7ad1d0a5f0aa.png",
	faviconUrl: null,
	primaryColor: "#C8283C",
	secondaryColor: null,
	font: null,
	supportUrl: null,
	termsUrl: null,
	privacyUrl: null,
	...overrides,
});

describe("parseHostBranding", () => {
	it("accepts the CareerOS shape", () => {
		const result = parseHostBranding(answer(), ORIGIN);
		expect(result).toEqual({
			ok: true,
			branding: {
				orgName: "Acme Careers",
				logoUrl: `${ORIGIN}/api/branding-assets/org_1/logo-0c8c3d5a-7f0e-4a4e-9b86-7ad1d0a5f0aa.png`,
				primaryColor: "#c8283c",
			},
		});
	});

	it("keeps a missing logo and colour as null", () => {
		const result = parseHostBranding(answer({ logoUrl: null, primaryColor: null }), ORIGIN);
		expect(result).toEqual({ ok: true, branding: { orgName: "Acme Careers", logoUrl: null, primaryColor: null } });
	});

	it.each([
		["null", null],
		["a string", "hello"],
		["an array", [answer()]],
		["a number", 7],
		["an empty object", {}],
		["a generic JSON API", { status: "ok", version: "1.0" }],
	])("refuses %s", (_name, body) => {
		expect(parseHostBranding(body, ORIGIN)).toEqual({ ok: false, reason: "not_careeros" });
	});

	it("refuses an answer that lacks a field", () => {
		const { slug: _slug, ...partial } = answer();
		expect(parseHostBranding(partial, ORIGIN)).toEqual({ ok: false, reason: "not_careeros" });
	});

	it("refuses an answer with a field of the wrong type", () => {
		expect(parseHostBranding(answer({ appName: 42 }), ORIGIN)).toEqual({ ok: false, reason: "not_careeros" });
		expect(parseHostBranding(answer({ logoUrl: { href: "x" } }), ORIGIN)).toEqual({
			ok: false,
			reason: "not_careeros",
		});
	});

	it("says so when the address belongs to no organization", () => {
		const platform = answer({
			organizationId: null,
			slug: null,
			appName: null,
			logoUrl: null,
			primaryColor: null,
		});
		expect(parseHostBranding(platform, ORIGIN)).toEqual({ ok: false, reason: "no_organization" });
	});

	it("drops a colour that is not #rrggbb", () => {
		for (const value of ["red", "#fff", "url(javascript:alert(1))", "#c8283c; background:red", "#GGGGGG"]) {
			const result = parseHostBranding(answer({ primaryColor: value }), ORIGIN);
			expect(result.ok && result.branding.primaryColor).toBeNull();
		}
	});

	it("keeps markup in a name as plain text and removes control characters", () => {
		const result = parseHostBranding(answer({ appName: "  <img src=x onerror=alert(1)>\u0000Acme\n " }), ORIGIN);
		expect(result.ok && result.branding.orgName).toBe("<img src=x onerror=alert(1)>Acme");
	});

	it("limits the length of a name", () => {
		const result = parseHostBranding(answer({ appName: "A".repeat(200) }), ORIGIN);
		expect(result.ok && result.branding.orgName).toHaveLength(60);
	});

	it("treats a name of only spaces as no organization", () => {
		expect(parseHostBranding(answer({ appName: "   " }), ORIGIN)).toEqual({ ok: false, reason: "no_organization" });
	});
});

describe("sameOriginLogo", () => {
	it("accepts a relative path and an absolute address on the same origin", () => {
		expect(sameOriginLogo("/logo.png", ORIGIN, [])).toBe(`${ORIGIN}/logo.png`);
		expect(sameOriginLogo(`${ORIGIN}/logo.png`, ORIGIN, [])).toBe(`${ORIGIN}/logo.png`);
	});

	it.each([
		["another host", "https://cdn.example.net/logo.png"],
		["a look-alike host", "https://careers.example.org.evil.test/logo.png"],
		["user info", "https://user@careers.example.org/logo.png"],
		["a protocol-relative address on another host", "//evil.test/logo.png"],
		["a data URL", "data:image/png;base64,AAAA"],
		["a javascript URL", "javascript:alert(1)"],
		["plain http", "http://careers.example.org/logo.png"],
		["a different port", "https://careers.example.org:8443/logo.png"],
		["an empty value", ""],
		["a non-string", 5],
	])("refuses %s", (_name, value) => {
		expect(sameOriginLogo(value, ORIGIN, [])).toBeNull();
	});

	it("accepts the origin's own http only for a development host", () => {
		expect(sameOriginLogo("/logo.png", "http://localhost:3000", ["localhost"])).toBe("http://localhost:3000/logo.png");
		expect(sameOriginLogo("/logo.png", "http://localhost:3000", [])).toBeNull();
	});
});

describe("fetchHostBranding", () => {
	const respond = (body: BodyInit | null, init?: ResponseInit) =>
		vi.fn<typeof fetch>().mockResolvedValue(new Response(body, init));

	it("asks the branding route without cookies or redirects", async () => {
		const fetchImpl = respond(JSON.stringify(answer()));
		const result = await fetchHostBranding(ORIGIN, [], fetchImpl);
		expect(result.ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toBe(`${ORIGIN}${BRANDING_PATH}`);
		expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store" });
	});

	it("reports an unreachable server", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
		expect(await fetchHostBranding(ORIGIN, [], fetchImpl)).toEqual({ ok: false, reason: "unreachable" });
	});

	it("refuses an HTTP error, a page that is not JSON and an oversized body", async () => {
		expect(await fetchHostBranding(ORIGIN, [], respond("nope", { status: 404 }))).toEqual({
			ok: false,
			reason: "not_careeros",
		});
		expect(await fetchHostBranding(ORIGIN, [], respond("<html></html>"))).toEqual({
			ok: false,
			reason: "not_careeros",
		});
		const huge = JSON.stringify(answer({ appName: "x".repeat(70 * 1024) }));
		expect(await fetchHostBranding(ORIGIN, [], respond(huge))).toEqual({ ok: false, reason: "not_careeros" });
	});

	it("refuses a server that answers with another JSON shape", async () => {
		expect(await fetchHostBranding(ORIGIN, [], respond(JSON.stringify({ hello: "world" })))).toEqual({
			ok: false,
			reason: "not_careeros",
		});
	});
});
