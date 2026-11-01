import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { clearPublicBrandingCache, createHostResolver, setHostResolverForTesting } from "@careeros/tenancy";

// P2-T04: which organization an email belongs to, and which origin its links use. The database is a stub that records
// the organization ids it was asked for; the host resolver is the real one (T03) with two organization hosts.
const mocks = vi.hoisted(() => ({
	env: {
		APP_URL: "https://app.example.com",
		ORG_HOST_PATTERN: "{slug}.orgs.example.com" as string | undefined,
	},
	lookups: [] as string[],
	rows: new Map<string, Record<string, unknown>>(),
	failLookup: false,
}));

vi.mock("@reactive-resume/env/server", () => ({ env: mocks.env }));
vi.mock("@reactive-resume/db/client", () => ({
	db: {
		execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
			const orgId = String(
				(query.queryChunks ?? []).find((chunk) => typeof chunk === "string" && chunk.startsWith("org")),
			);
			mocks.lookups.push(orgId);
			if (mocks.failLookup) throw new Error("database down password=secret");
			const row = mocks.rows.get(orgId);
			return { rows: row ? [row] : [] };
		}),
	},
}));

const { buildEmailContext, orgSubdomainOrigin, resolveEmailBrandOrg, withLinkOrigin } = await import("./email-brand");

const row = (id: string, slug: string, extra: Record<string, unknown> = {}) => ({
	organization_id: id,
	slug,
	app_name: null,
	logo_storage_key: null,
	primary_color: null,
	support_url: null,
	terms_url: null,
	privacy_url: null,
	email_from_name: null,
	email_reply_to: null,
	...extra,
});

const request = (host: string, headers: Record<string, string> = {}) =>
	new Request(`https://${host}/api/auth/request-password-reset`, { method: "POST", headers: { host, ...headers } });

const LOGO = "orgs/orgA/branding/logo-11111111-1111-1111-1111-111111111111.png";

beforeEach(() => {
	mocks.lookups.length = 0;
	mocks.rows.clear();
	mocks.failLookup = false;
	mocks.env.ORG_HOST_PATTERN = "{slug}.orgs.example.com";
	clearPublicBrandingCache();
	mocks.rows.set(
		"orgA",
		row("orgA", "acme", {
			app_name: "Acme Careers",
			logo_storage_key: LOGO,
			primary_color: "#FFFF00",
			support_url: "https://acme.example/help",
			email_from_name: "Acme Team",
			email_reply_to: "help@acme.example",
		}),
	);
	mocks.rows.set("orgB", row("orgB", "beta", { app_name: "Beta Jobs" }));
	setHostResolverForTesting(
		createHostResolver({
			platformHosts: new Set(["app.example.com"]),
			orgHostPattern: mocks.env.ORG_HOST_PATTERN,
			trustForwardedHost: false,
			protocol: "https:",
			lookupBySlug: async (slug) =>
				slug === "acme" ? { organizationId: "orgA", slug } : slug === "beta" ? { organizationId: "orgB", slug } : null,
		}),
	);
});

describe("resolveEmailBrandOrg", () => {
	it("uses the inviting organization for an invitation", async () => {
		await expect(resolveEmailBrandOrg({ source: "invitation", organizationId: "orgB" })).resolves.toBe("orgB");
	});

	it("uses the row's organization for a career notification", async () => {
		await expect(resolveEmailBrandOrg({ source: "organization", organizationId: "orgA" })).resolves.toBe("orgA");
	});

	it("brands a reset requested on org A's host as org A, whatever the user's memberships are", async () => {
		// The resolver takes no user at all: a member of both A and B gets the brand of the host they are on.
		await expect(resolveEmailBrandOrg({ source: "request", request: request("acme.orgs.example.com") })).resolves.toBe(
			"orgA",
		);
		await expect(resolveEmailBrandOrg({ source: "request", request: request("beta.orgs.example.com") })).resolves.toBe(
			"orgB",
		);
	});

	it("gives the platform default on the platform host, on an unknown host and with no request", async () => {
		await expect(resolveEmailBrandOrg({ source: "request", request: request("app.example.com") })).resolves.toBeNull();
		await expect(
			resolveEmailBrandOrg({ source: "request", request: request("ghost.orgs.example.com") }),
		).resolves.toBeNull();
		await expect(resolveEmailBrandOrg({ source: "request", request: request("evil.example") })).resolves.toBeNull();
		await expect(resolveEmailBrandOrg({ source: "request", request: undefined })).resolves.toBeNull();
	});

	it("ignores a forged X-Forwarded-Host while TRUST_FORWARDED_HOST is off", async () => {
		const forged = request("app.example.com", { "x-forwarded-host": "acme.orgs.example.com" });
		await expect(resolveEmailBrandOrg({ source: "request", request: forged })).resolves.toBeNull();
	});
});

describe("buildEmailContext", () => {
	it("builds the full brand for a request on an organization host", async () => {
		const mail = await buildEmailContext({ source: "request", request: request("acme.orgs.example.com") });
		expect(mail).toMatchObject({
			organizationId: "orgA",
			fromName: "Acme Team",
			replyTo: "help@acme.example",
			linkOrigin: "https://acme.orgs.example.com",
		});
		expect(mail.brand).toEqual({
			appName: "Acme Careers",
			logoUrl: "https://acme.orgs.example.com/api/branding-assets/orgA/logo-11111111-1111-1111-1111-111111111111.png",
			primaryColor: "#ffff00",
			primaryForeground: "#000000",
			supportUrl: "https://acme.example/help",
			privacyUrl: undefined,
			termsUrl: undefined,
		});
	});

	it("gives the platform default, with links on APP_URL, on the platform host and without a request", async () => {
		for (const input of [
			{ source: "request", request: request("app.example.com") },
			{ source: "request", request: undefined },
		] as const) {
			const mail = await buildEmailContext(input);
			expect(mail).toMatchObject({ organizationId: null, fromName: undefined, replyTo: undefined });
			expect(mail.brand.appName).toBe("CareerOS");
			expect(mail.linkOrigin).toBe("https://app.example.com");
		}
		expect(mocks.lookups).toEqual([]);
	});

	it("links a forged X-Forwarded-Host request to APP_URL", async () => {
		const forged = request("app.example.com", { "x-forwarded-host": "acme.orgs.example.com" });
		const mail = await buildEmailContext({ source: "request", request: forged });
		expect(mail.linkOrigin).toBe("https://app.example.com");
		expect(mail.organizationId).toBeNull();
	});

	it("sends an invitation to the inviting organization's own host and brands it with that organization", async () => {
		const mail = await buildEmailContext({ source: "invitation", organizationId: "orgB" });
		expect(mail.linkOrigin).toBe("https://beta.orgs.example.com");
		expect(mail.brand.appName).toBe("Beta Jobs");
		expect(mail.fromName).toBe("Beta Jobs");
	});

	it("keeps an invitation on APP_URL when organization hosts are off", async () => {
		mocks.env.ORG_HOST_PATTERN = undefined;
		const mail = await buildEmailContext({ source: "invitation", organizationId: "orgB" });
		expect(mail.linkOrigin).toBe("https://app.example.com");
	});

	it("keeps career notification links on APP_URL while the logo comes from the organization's host", async () => {
		const mail = await buildEmailContext({ source: "organization", organizationId: "orgA" });
		expect(mail.linkOrigin).toBe("https://app.example.com");
		expect(mail.brand.logoUrl?.startsWith("https://acme.orgs.example.com/api/branding-assets/orgA/")).toBe(true);
	});

	it("serves the logo from APP_URL when the organization has no host of its own", async () => {
		mocks.env.ORG_HOST_PATTERN = undefined;
		const mail = await buildEmailContext({ source: "organization", organizationId: "orgA" });
		expect(mail.brand.logoUrl?.startsWith("https://app.example.com/api/branding-assets/orgA/")).toBe(true);
	});

	it("leaves out an SVG or WebP logo, so the template shows the name", async () => {
		for (const ext of ["svg", "webp"]) {
			clearPublicBrandingCache();
			mocks.rows.set("orgA", row("orgA", "acme", { logo_storage_key: LOGO.replace(".png", `.${ext}`) }));
			expect(
				(await buildEmailContext({ source: "organization", organizationId: "orgA" })).brand.logoUrl,
			).toBeUndefined();
		}
	});

	it("cleans a hostile sender name and drops a bad reply-to", async () => {
		mocks.rows.set(
			"orgA",
			row("orgA", "acme", {
				app_name: "Acme\r\nBcc: a@b.c",
				email_from_name: '"x\r\nBcc: a@b.c',
				email_reply_to: "a@b.c\r\nBcc: x@y.z",
			}),
		);
		const mail = await buildEmailContext({ source: "organization", organizationId: "orgA" });
		expect(mail.fromName).not.toMatch(/[\r\n"]/);
		expect(mail.brand.appName).not.toMatch(/[\r\n]/);
		expect(mail.replyTo).toBeUndefined();
	});

	it("falls back to the platform default when the lookup fails, without logging the error", async () => {
		mocks.failLookup = true;
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const mail = await buildEmailContext({ source: "organization", organizationId: "orgA" });
		expect(mail.organizationId).toBeNull();
		expect(mail.brand.appName).toBe("CareerOS");
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("caches an organization's branding for the sends that follow", async () => {
		await buildEmailContext({ source: "organization", organizationId: "orgA" });
		await buildEmailContext({ source: "invitation", organizationId: "orgA" });
		expect(mocks.lookups).toEqual(["orgA"]);
	});
});

describe("withLinkOrigin", () => {
	it("replaces only the origin and keeps the path, the token and the rest of the query byte for byte", () => {
		const token = "abc.DEF-123_%2Fx~y";
		const link = `https://app.example.com/api/auth/reset-password/${token}?callbackURL=%2Fauth%2Freset-password&token=${token}#frag`;
		const rewritten = withLinkOrigin(link, "https://acme.orgs.example.com");
		expect(rewritten).toBe(link.replace("https://app.example.com", "https://acme.orgs.example.com"));
		expect(new URL(rewritten).searchParams.get("token")).toBe(new URL(link).searchParams.get("token"));
	});

	it("drops the old port when the target origin has none, and cannot be steered by a protocol-relative path", () => {
		expect(withLinkOrigin("http://localhost:3000/a?token=t", "https://acme.orgs.example.com")).toBe(
			"https://acme.orgs.example.com/a?token=t",
		);
		expect(withLinkOrigin("https://app.example.com//evil.example/x?token=t", "https://acme.orgs.example.com")).toBe(
			"https://acme.orgs.example.com//evil.example/x?token=t",
		);
	});

	it("keeps a port on the target origin", () => {
		expect(withLinkOrigin("https://app.example.com/a?token=t", "http://acme.localhost:3000")).toBe(
			"http://acme.localhost:3000/a?token=t",
		);
	});
});

describe("orgSubdomainOrigin", () => {
	it("is the pattern host with the scheme of APP_URL, and nothing when org hosts are off or the slug is odd", () => {
		expect(orgSubdomainOrigin("acme")).toBe("https://acme.orgs.example.com");
		expect(orgSubdomainOrigin("a.b")).toBeUndefined();
		expect(orgSubdomainOrigin("UPPER")).toBeUndefined();
		mocks.env.ORG_HOST_PATTERN = undefined;
		expect(orgSubdomainOrigin("acme")).toBeUndefined();
	});
});
