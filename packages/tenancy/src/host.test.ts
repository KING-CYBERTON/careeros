import { describe, expect, it, vi } from "vite-plus/test";
import {
	createHostResolver,
	matchOrgHost,
	normalizeHostname,
	parseHost,
	parseOrgHostPattern,
	type HostOrg,
} from "./host";

vi.mock("@reactive-resume/db/client", () => ({ db: {} }));
vi.mock("@reactive-resume/env/server", () => ({
	env: { APP_URL: "https://app.example.com", APP_ALIAS_URL: undefined, ORG_HOST_PATTERN: undefined },
}));

const request = (host: string | null, headers: Record<string, string> = {}) =>
	new Request("https://app.example.com/api/rpc", { headers: { ...(host ? { host } : {}), ...headers } });

describe("host normalization", () => {
	it("lower-cases, strips the port and one trailing dot", () => {
		expect(normalizeHostname("Acme-CareerOS.Example.COM:8443")).toBe("acme-careeros.example.com");
		expect(normalizeHostname("acme.example.com.")).toBe("acme.example.com");
		expect(parseHost("acme.example.com:3000")).toEqual({ hostname: "acme.example.com", port: "3000" });
	});

	it("converts internationalized names to punycode", () => {
		expect(normalizeHostname("bücher.example.com")).toBe("xn--bcher-kva.example.com");
	});

	it("accepts IP literals", () => {
		expect(normalizeHostname("127.0.0.1:3000")).toBe("127.0.0.1");
		expect(normalizeHostname("[::1]:3000")).toBe("[::1]");
	});

	it.each([
		"",
		"   ",
		"a b.example.com",
		"evil.com/path",
		"user@evil.com",
		"a..b.example.com",
		"-bad.example.com",
		"under_score.example.com",
		"host:notaport",
		"a.example.com?x=1",
		"a%2eexample.com",
		"x".repeat(64) + ".example.com",
	])("rejects %j", (value) => {
		expect(normalizeHostname(value)).toBeNull();
	});

	it("rejects missing values", () => {
		expect(normalizeHostname(null)).toBeNull();
		expect(normalizeHostname(undefined)).toBeNull();
	});
});

describe("organization host pattern", () => {
	it("needs exactly one {slug} and a valid host name", () => {
		expect(parseOrgHostPattern("{slug}-careeros.ayopa.co.ke")).toEqual({ prefix: "", suffix: "-careeros.ayopa.co.ke" });
		expect(parseOrgHostPattern("{slug}.example.com")).toEqual({ prefix: "", suffix: ".example.com" });
		expect(parseOrgHostPattern("org-{slug}.example.com")).toEqual({ prefix: "org-", suffix: ".example.com" });
		expect(parseOrgHostPattern("example.com")).toBeNull();
		expect(parseOrgHostPattern("{slug}.{slug}.example.com")).toBeNull();
		expect(parseOrgHostPattern("{slug}.example.com:3000")).toBeNull();
		expect(parseOrgHostPattern("{slug}/x.example.com")).toBeNull();
		expect(parseOrgHostPattern(undefined)).toBeNull();
	});

	it("matches a slug of [a-z0-9-]{1,63} without dots", () => {
		const staging = parseOrgHostPattern("{slug}-careeros.ayopa.co.ke");
		const production = parseOrgHostPattern("{slug}.example.com");
		if (!staging || !production) throw new Error("pattern");
		expect(matchOrgHost("acme-careeros.ayopa.co.ke", staging)).toBe("acme");
		expect(matchOrgHost("a-b-careeros.ayopa.co.ke", staging)).toBe("a-b");
		expect(matchOrgHost("-careeros.ayopa.co.ke", staging)).toBeNull();
		expect(matchOrgHost("acme.example.com", staging)).toBeNull();
		expect(matchOrgHost("acme.example.com", production)).toBe("acme");
		expect(matchOrgHost("a.b.example.com", production)).toBeNull();
		expect(matchOrgHost(".example.com", production)).toBeNull();
		expect(matchOrgHost("example.com", production)).toBeNull();
		expect(matchOrgHost(`${"a".repeat(64)}.example.com`, production)).toBeNull();
		expect(matchOrgHost(`${"a".repeat(63)}.example.com`, production)).toBe("a".repeat(63));
		expect(matchOrgHost("evil.example.com.attacker.net", production)).toBeNull();
	});
});

describe("host resolver", () => {
	const acme: HostOrg = { organizationId: "org-acme", slug: "acme" };
	const makeResolver = (overrides: Partial<Parameters<typeof createHostResolver>[0]> = {}) => {
		const lookup = vi.fn(async (slug: string) => (slug === "acme" ? acme : null));
		const resolve = createHostResolver({
			platformHosts: new Set(["app.example.com", "localhost"]),
			orgHostPattern: "{slug}.example.com",
			lookupBySlug: lookup,
			...overrides,
		});
		return { resolve, lookup };
	};

	it("answers platform for the platform hosts, with or without a port", async () => {
		const { resolve, lookup } = makeResolver();
		expect(await resolve(request("app.example.com"))).toEqual({ kind: "platform" });
		expect(await resolve(request("APP.example.com:443"))).toEqual({ kind: "platform" });
		expect(await resolve(request("localhost:3000"))).toEqual({ kind: "platform" });
		expect(lookup).not.toHaveBeenCalled();
	});

	it("resolves an organization subdomain through the lookup", async () => {
		const { resolve, lookup } = makeResolver();
		expect(await resolve(request("acme.example.com"))).toEqual({
			kind: "org",
			organizationId: "org-acme",
			slug: "acme",
			via: "subdomain",
			hostname: "acme.example.com",
			origin: "https://acme.example.com",
		});
		expect(lookup).toHaveBeenCalledWith("acme");
	});

	it("builds the origin with the scheme of APP_URL and the port as sent", async () => {
		const { resolve } = makeResolver({ protocol: "http:" });
		const host = await resolve(request("acme.example.com:3000"));
		expect(host).toMatchObject({ kind: "org", origin: "http://acme.example.com:3000" });
		const https = await makeResolver().resolve(request("acme.example.com:443"));
		expect(https).toMatchObject({ kind: "org", origin: "https://acme.example.com" });
	});

	it("answers unknown for an unknown slug, flagged as an organization host shape", async () => {
		const { resolve } = makeResolver();
		expect(await resolve(request("nobody.example.com"))).toEqual({ kind: "unknown", matchesOrgPattern: true });
	});

	it("answers unknown, not an organization, for other hosts (a per-user resume domain)", async () => {
		const customDomainOrg = vi.fn(async () => null);
		const { resolve, lookup } = makeResolver({ customDomainOrg });
		expect(await resolve(request("cv.jane-doe.dev"))).toEqual({ kind: "unknown", matchesOrgPattern: false });
		expect(lookup).not.toHaveBeenCalled();
		expect(customDomainOrg).toHaveBeenCalledWith("cv.jane-doe.dev");
	});

	it("never resolves a per-user resume custom domain as an organization", async () => {
		// The resolver has no access to the `custom_domain` table: only the slug lookup and the T06 hook decide.
		const { resolve } = makeResolver({ orgHostPattern: "{slug}.example.com" });
		const host = await resolve(request("resume.some-user.com"));
		expect(host.kind).not.toBe("org");
	});

	it("rejects a malformed Host header as unknown", async () => {
		const { resolve } = makeResolver();
		expect(await resolve(request("evil.com/x"))).toEqual({ kind: "unknown", matchesOrgPattern: false });
	});

	it("does not look at X-Forwarded-Host unless TRUST_FORWARDED_HOST is on", async () => {
		const forged = request("app.example.com", { "x-forwarded-host": "acme.example.com" });
		expect(await makeResolver().resolve(forged)).toEqual({ kind: "platform" });
		const trusting = makeResolver({ trustForwardedHost: true });
		expect(await trusting.resolve(forged)).toMatchObject({ kind: "org", organizationId: "org-acme" });
		// The first value of a proxy chain wins.
		const chain = request("app.example.com", { "x-forwarded-host": "acme.example.com, other.example.com" });
		expect(await trusting.resolve(chain)).toMatchObject({ kind: "org", slug: "acme" });
	});

	it("is the platform everywhere when ORG_HOST_PATTERN is unset (Phase 1 behaviour)", async () => {
		const { resolve, lookup } = makeResolver({ orgHostPattern: undefined });
		expect(await resolve(request("acme.example.com"))).toEqual({ kind: "platform" });
		expect(await resolve(request("anything.test"))).toEqual({ kind: "platform" });
		expect(lookup).not.toHaveBeenCalled();
	});

	it("resolves a custom-domain organization through the T06 hook, with via custom", async () => {
		const customDomainOrg = vi.fn(async (hostname: string) =>
			hostname === "jobs.acme.org" ? { organizationId: "org-acme", slug: "acme" } : null,
		);
		const { resolve } = makeResolver({ customDomainOrg });
		expect(await resolve(request("jobs.acme.org"))).toMatchObject({
			kind: "org",
			via: "custom",
			organizationId: "org-acme",
		});
		expect(await resolve(request("jobs.other.org"))).toEqual({ kind: "unknown", matchesOrgPattern: false });
	});

	describe("cache", () => {
		it("serves positive and negative results from memory for 60 seconds", async () => {
			let clock = 1_000;
			const { resolve, lookup } = makeResolver({ now: () => clock });
			await resolve(request("acme.example.com"));
			await resolve(request("acme.example.com"));
			await resolve(request("nobody.example.com"));
			await resolve(request("nobody.example.com"));
			expect(lookup).toHaveBeenCalledTimes(2);
			clock += 59_999;
			await resolve(request("acme.example.com"));
			expect(lookup).toHaveBeenCalledTimes(2);
			clock += 2;
			await resolve(request("acme.example.com"));
			expect(lookup).toHaveBeenCalledTimes(3);
		});

		it("holds at most maxEntries and evicts the oldest", async () => {
			const lookup = vi.fn(async (slug: string) => ({ organizationId: `org-${slug}`, slug }));
			const resolve = createHostResolver({
				platformHosts: new Set(),
				orgHostPattern: "{slug}.example.com",
				lookupBySlug: lookup,
				maxEntries: 2,
			});
			for (const slug of ["a", "b", "c"]) await resolve(request(`${slug}.example.com`));
			expect(lookup).toHaveBeenCalledTimes(3);
			await resolve(request("c.example.com"));
			await resolve(request("b.example.com"));
			expect(lookup).toHaveBeenCalledTimes(3);
			await resolve(request("a.example.com"));
			expect(lookup).toHaveBeenCalledTimes(4);
		});

		it("drops entries for a slug and for an organization on bust", async () => {
			const { resolve, lookup } = makeResolver();
			await resolve(request("acme.example.com"));
			resolve.bust({ organizationId: "org-acme" });
			await resolve(request("acme.example.com"));
			expect(lookup).toHaveBeenCalledTimes(2);
			resolve.bust({ slug: "acme" });
			await resolve(request("acme.example.com"));
			expect(lookup).toHaveBeenCalledTimes(3);
		});
	});
});
