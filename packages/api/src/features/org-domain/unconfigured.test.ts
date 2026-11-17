import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// P2-T06: with CF_SAAS_API_TOKEN, CF_ZONE_ID or CF_SAAS_CNAME_TARGET unset the feature reports "not configured" and
// nothing calls Cloudflare. No database is needed: the checks come before any query.
vi.hoisted(() => {
	delete process.env.CF_SAAS_API_TOKEN;
	delete process.env.CF_ZONE_ID;
	delete process.env.CF_SAAS_CNAME_TARGET;
	process.env.CF_SAAS_API_TOKEN = "";
});

vi.mock("../branding/service", async (importOriginal) => ({
	...(await importOriginal<typeof import("../branding/service")>()),
	requireOrganizationAdmin: vi.fn(async () => "org_test"),
}));

const fetchSpy = vi.fn<typeof fetch>(async () => new Response("{}"));
vi.stubGlobal("fetch", fetchSpy);

afterEach(() => fetchSpy.mockClear());

describe("organization custom domains without Cloudflare for SaaS settings", () => {
	it("reports them as not configured", async () => {
		const { isOrgDomainsConfigured } = await import("./service");
		expect(isOrgDomainsConfigured()).toBe(false);
		const { getCloudflareClient } = await import("./cloudflare");
		expect(getCloudflareClient()).toBeNull();
	});

	it("refuses to add a domain with a clear error and does not call Cloudflare", async () => {
		const { addDomain } = await import("./service");
		await expect(addDomain("user", "careers.acme.example.test")).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			status: 412,
			message: "Custom domains for organizations aren't set up on this server.",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("runs no scheduled work: no database query and no Cloudflare call", async () => {
		const { runOrgDomainJobs } = await import("./jobs");
		await expect(runOrgDomainJobs()).resolves.toEqual({ checked: 0, failed: 0, cleaned: 0 });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("leaves the host lookup off, so no organization custom domain can resolve", async () => {
		const { orgCustomDomainsEnabled } = await import("@careeros/tenancy");
		expect(orgCustomDomainsEnabled()).toBe(false);
	});
});
