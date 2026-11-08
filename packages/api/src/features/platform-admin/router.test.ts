import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createProcedureClient } from "@orpc/server";

// CAREEROS (P3-T07): the console's gates in the API layer, with the database mocked: the host decides (404 off the
// platform host), only a browser session reaches it, the actor is the session's user, a refusal of the database
// functions maps to 404 (not an admin) or 403 with a code (two-factor), and a support session is refused.

const platformAdmin = vi.hoisted(() => {
	class AdminError extends Error {
		readonly code: string;
		constructor(code: string, message?: string) {
			super(message ?? code);
			this.code = code;
		}
	}
	return {
		AdminError,
		listOrgs: vi.fn(),
		getOrg: vi.fn(),
		setOrgStatus: vi.fn(),
		startImpersonation: vi.fn(),
		endImpersonation: vi.fn(),
		getImpersonationForSession: vi.fn(),
		isImpersonationActive: vi.fn(),
		assertPlatformAdmin: vi.fn(),
		activeAnnouncementsForMember: vi.fn(),
		dismissAnnouncement: vi.fn(),
	};
});
const tenancy = vi.hoisted(() => ({ host: undefined as unknown }));

vi.mock("@reactive-resume/auth/config", () => ({ auth: { api: {} }, verifyOAuthToken: vi.fn() }));
vi.mock("@reactive-resume/auth/email-brand", () => ({
	orgSubdomainOrigin: (slug: string) => `https://${slug}.orgs.test`,
}));
vi.mock("@reactive-resume/db/client", () => ({ db: {} }));
vi.mock("@reactive-resume/db/schema", () => ({ user: { __table: "user" } }));
vi.mock("drizzle-orm", () => ({ eq: () => "EQ" }));
vi.mock("@careeros/billing", () => ({
	listActivePlans: vi.fn(async () => [{ id: "pro", name: "Pro" }]),
	runWithEntitlementsCache: (fn: () => unknown) => fn(),
}));
vi.mock("@careeros/platform-admin", () => platformAdmin);
vi.mock("../../middleware/entitlements", () => ({
	enforceOrganizationStatus: async ({ next }: { next: () => unknown }) => next(),
	SUSPENDED_ORG_ALLOWED_WRITES: new Map(),
}));
vi.mock("../../middleware/rate-limit", () => ({
	accountRateLimit: async ({ next }: { next: () => unknown }) => next(),
}));
vi.mock("@careeros/tenancy", () => ({
	ORG_CONTEXT_REQUIRED: true,
	resolveOrgForAuthentication: vi.fn(async () => "org_a"),
	withOrgContext: async (_org: string, fn: () => unknown) => fn(),
	currentHost: () => tenancy.host,
	TenancyError: class TenancyError extends Error {},
}));

const { adminRouter, announcementsRouter, impersonationRouter } = await import("./router");

const user = { id: "admin-1" };
const session = (extra: Record<string, unknown> = {}) => ({
	user,
	method: "session" as const,
	permissions: ["read", "write", "delete"] as const,
	sessionId: "sess-1",
	...extra,
});
const call = <T>(procedure: T, path: string[], authentication: unknown, host?: unknown) =>
	createProcedureClient(procedure as never, {
		path,
		context: { locale: "en-US", reqHeaders: new Headers(), authentication, host },
	}) as (input?: unknown) => Promise<unknown>;

const listOrgs = (authentication: unknown, host?: unknown) =>
	call(adminRouter.orgs.list, ["admin", "orgs", "list"], authentication, host);

beforeEach(() => {
	for (const fn of Object.values(platformAdmin)) if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
	tenancy.host = undefined;
	platformAdmin.listOrgs.mockResolvedValue({ rows: [], total: 0 });
});

describe("admin procedures: host and credential", () => {
	it("answer on the platform host, with the session's user as the actor", async () => {
		await expect(listOrgs(session(), { kind: "platform" })({ search: "acme" })).resolves.toEqual({
			rows: [],
			total: 0,
		});
		expect(platformAdmin.listOrgs).toHaveBeenCalledWith("admin-1", { search: "acme" });
	});

	it("treats no host as the platform host", async () => {
		await expect(listOrgs(session())()).resolves.toBeDefined();
	});

	it.each([
		[
			"an organization host",
			{
				kind: "org",
				organizationId: "org_a",
				slug: "a",
				via: "subdomain",
				hostname: "a.orgs.test",
				origin: "https://a.orgs.test",
			},
		],
		[
			"a custom domain",
			{
				kind: "org",
				organizationId: "org_a",
				slug: "a",
				via: "custom",
				hostname: "jobs.acme.test",
				origin: "https://jobs.acme.test",
			},
		],
		["an unknown host", { kind: "unknown", matchesOrgPattern: false }],
	])("answer 404 on %s, before anything reaches the database", async (_name, host) => {
		await expect(listOrgs(session(), host)()).rejects.toMatchObject({ code: "NOT_FOUND" });
		tenancy.host = host;
		await expect(listOrgs(session())()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(platformAdmin.listOrgs).not.toHaveBeenCalled();
	});

	it("never serve an API key or a bearer token", async () => {
		for (const method of ["apiKey", "bearer"] as const)
			await expect(listOrgs(session({ method }), { kind: "platform" })()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(platformAdmin.listOrgs).not.toHaveBeenCalled();
	});

	it("need a signed-in user", async () => {
		await expect(listOrgs(null, { kind: "platform" })()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("admin procedures: what the database says", () => {
	it("a user who is not an admin gets 404, like an unknown route", async () => {
		platformAdmin.listOrgs.mockRejectedValue(new platformAdmin.AdminError("not_admin"));
		await expect(listOrgs(session(), { kind: "platform" })()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("an admin without two-factor authentication gets 403 TWO_FACTOR_REQUIRED", async () => {
		platformAdmin.listOrgs.mockRejectedValue(new platformAdmin.AdminError("two_factor_required"));
		await expect(listOrgs(session(), { kind: "platform" })()).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { code: "TWO_FACTOR_REQUIRED" },
		});
	});

	it("an invalid request is a 400 with the message", async () => {
		platformAdmin.setOrgStatus.mockRejectedValue(
			new platformAdmin.AdminError("invalid", "the organization is already suspended"),
		);
		await expect(
			call(adminRouter.orgs.setStatus, ["admin", "orgs", "setStatus"], session(), { kind: "platform" })({
				organizationId: "org_a",
				status: "suspended",
				reason: "unpaid invoice 42",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message: "the organization is already suspended" });
	});

	it("a status change needs a reason of at least 10 characters", async () => {
		await expect(
			call(adminRouter.orgs.setStatus, ["admin", "orgs", "setStatus"], session(), { kind: "platform" })({
				organizationId: "org_a",
				status: "suspended",
				reason: "short",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(platformAdmin.setOrgStatus).not.toHaveBeenCalled();
	});

	it("lists the plans only for an admin", async () => {
		platformAdmin.assertPlatformAdmin.mockRejectedValue(new platformAdmin.AdminError("not_admin"));
		await expect(call(adminRouter.plans, ["admin", "plans"], session(), { kind: "platform" })()).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		platformAdmin.assertPlatformAdmin.mockResolvedValue(undefined);
		await expect(call(adminRouter.plans, ["admin", "plans"], session(), { kind: "platform" })()).resolves.toEqual([
			{ id: "pro", name: "Pro" },
		]);
	});
});

describe("starting a support session", () => {
	const start = (authentication = session()) =>
		call(adminRouter.impersonation.start, ["admin", "impersonation", "start"], authentication, { kind: "platform" })({
			organizationId: "org_a",
			userId: "member-1",
			reason: "customer cannot export",
		});

	it("returns a URL on the member's organization host with the token in the fragment", async () => {
		platformAdmin.getOrg.mockResolvedValue({ organization: { slug: "acme" } });
		const expiresAt = new Date(Date.now() + 3_600_000);
		platformAdmin.startImpersonation.mockResolvedValue({
			id: "imp-id-1234567890ab",
			token: "tok-1234567890abcdef",
			expiresAt,
		});
		const result = (await start()) as { url: string; expiresAt: Date };
		const url = new URL(result.url);
		expect(url.origin).toBe("https://acme.orgs.test");
		expect(url.pathname).toBe("/auth/impersonate");
		expect(url.search).toBe("");
		expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe("tok-1234567890abcdef");
		expect(platformAdmin.startImpersonation).toHaveBeenCalledWith("admin-1", {
			targetUserId: "member-1",
			organizationId: "org_a",
			reason: "customer cannot export",
			targetOrigin: "https://acme.orgs.test",
		});
		expect(result.expiresAt).toBe(expiresAt);
	});

	it("is refused for an admin target by the database", async () => {
		platformAdmin.getOrg.mockResolvedValue({ organization: { slug: "acme" } });
		platformAdmin.startImpersonation.mockRejectedValue(
			new platformAdmin.AdminError("cannot_impersonate_admin", "a platform admin cannot be impersonated"),
		);
		await expect(start()).rejects.toMatchObject({ code: "FORBIDDEN", data: { code: "CANNOT_IMPERSONATE_ADMIN" } });
	});
});

describe("support sessions (impersonated)", () => {
	const impersonated = session({ impersonatedBy: "admin-9" });

	it("cannot use the console, even on the platform host", async () => {
		await expect(listOrgs(impersonated, { kind: "platform" })()).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { code: "IMPERSONATION_NOT_ALLOWED" },
		});
		expect(platformAdmin.listOrgs).not.toHaveBeenCalled();
	});

	it("cannot reach the procedures the policy lists", async () => {
		const { protectedProcedureWithoutOrg } = await import("../../context");
		const ran = protectedProcedureWithoutOrg.handler(() => "ran");
		for (const path of [
			"auth.deleteAccount",
			"auth.createApiKey",
			"auth.apiKeys.delete",
			"billing.checkout",
			"billing.cancel",
		])
			await expect(call(ran, path.split("."), impersonated)()).rejects.toMatchObject({
				data: { code: "IMPERSONATION_NOT_ALLOWED" },
			});
		// The same procedure for an ordinary session, and another procedure for the support session, run.
		await expect(call(ran, ["auth", "deleteAccount"], session())()).resolves.toBe("ran");
		await expect(call(ran, ["resume", "list"], impersonated)()).resolves.toBe("ran");
	});

	it("shows the banner data only for a support session", async () => {
		platformAdmin.getImpersonationForSession.mockResolvedValue({ id: "imp-1" });
		await expect(call(impersonationRouter.current, ["impersonation", "current"], impersonated)()).resolves.toEqual({
			id: "imp-1",
		});
		expect(platformAdmin.getImpersonationForSession).toHaveBeenCalledWith("sess-1", "admin-1");
		platformAdmin.getImpersonationForSession.mockClear();
		await expect(call(impersonationRouter.current, ["impersonation", "current"], session())()).resolves.toBeNull();
		expect(platformAdmin.getImpersonationForSession).not.toHaveBeenCalled();
	});

	it("lets the member end it now, and does nothing for an ordinary session", async () => {
		platformAdmin.endImpersonation.mockResolvedValue(true);
		await expect(call(impersonationRouter.end, ["impersonation", "end"], impersonated)()).resolves.toEqual({
			ended: true,
		});
		expect(platformAdmin.endImpersonation).toHaveBeenCalledWith("sess-1", "admin-1");
		platformAdmin.endImpersonation.mockClear();
		await expect(call(impersonationRouter.end, ["impersonation", "end"], session())()).resolves.toEqual({
			ended: false,
		});
		expect(platformAdmin.endImpersonation).not.toHaveBeenCalled();
	});
});

describe("announcements for members", () => {
	it("reads for the signed-in user in the host's organization, and dismisses for that user only", async () => {
		platformAdmin.activeAnnouncementsForMember.mockResolvedValue([{ id: "a1", title: "Maintenance" }]);
		await expect(call(announcementsRouter.active, ["announcements", "active"], session())()).resolves.toEqual([
			{ id: "a1", title: "Maintenance" },
		]);
		expect(platformAdmin.activeAnnouncementsForMember).toHaveBeenCalledWith("admin-1", "org_a");
		platformAdmin.dismissAnnouncement.mockResolvedValue(true);
		await expect(
			call(announcementsRouter.dismiss, ["announcements", "dismiss"], session())({ id: "a1" }),
		).resolves.toEqual({
			dismissed: true,
		});
		expect(platformAdmin.dismissAnnouncement).toHaveBeenCalledWith("admin-1", "a1");
	});
});
