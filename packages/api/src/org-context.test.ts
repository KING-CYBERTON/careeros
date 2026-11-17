import { describe, expect, it, vi } from "vite-plus/test";
import { createProcedureClient } from "@orpc/server";

const authMock = vi.hoisted(() => ({ api: { getSession: vi.fn(), verifyApiKey: vi.fn() } }));
const dbMock = vi.hoisted(() => ({ select: vi.fn() }));
const tenancy = vi.hoisted(() => ({
	resolveOrgForAuthentication: vi.fn(),
	withOrgContext: vi.fn(),
	inScope: false,
	required: true,
	registeredHost: undefined as unknown,
}));

vi.mock("@reactive-resume/auth/config", () => ({ auth: authMock, verifyOAuthToken: vi.fn() }));
vi.mock("@reactive-resume/db/client", () => ({ db: dbMock }));
vi.mock("@reactive-resume/db/schema", () => ({ user: { __table: "user" } }));
vi.mock("drizzle-orm", () => ({ eq: () => "EQ" }));
// Declared here, this mock replaces the shared one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", () => ({
	get ORG_CONTEXT_REQUIRED() {
		return tenancy.required;
	},
	resolveOrgForAuthentication: tenancy.resolveOrgForAuthentication,
	withOrgContext: tenancy.withOrgContext,
	// P2-T03
	currentHost: () => tenancy.registeredHost,
	TenancyError: class TenancyError extends Error {
		readonly code: string;
		constructor(code: string) {
			super(code);
			this.code = code;
		}
	},
}));

const { protectedProcedure, protectedProcedureWithoutOrg, publicProcedure, resolveAuthenticationFromRequestHeaders } =
	await import("./context");

const user = { id: "owner" };
const authentication = (extra: Record<string, unknown> = {}) => ({
	user,
	method: "session" as const,
	permissions: ["read", "write", "delete"] as const,
	...extra,
});
const client = <T>(procedure: T, auth: unknown) =>
	createProcedureClient(procedure as never, {
		context: { locale: "en-US", reqHeaders: new Headers(), authentication: auth },
	}) as (input: undefined) => Promise<unknown>;

const reset = () => {
	tenancy.resolveOrgForAuthentication.mockReset();
	tenancy.withOrgContext.mockReset();
	tenancy.inScope = false;
	tenancy.required = true;
	tenancy.registeredHost = undefined;
	tenancy.withOrgContext.mockImplementation(async (_org: string, fn: () => Promise<unknown>) => {
		tenancy.inScope = true;
		try {
			return await fn();
		} finally {
			tenancy.inScope = false;
		}
	});
};

describe("protectedProcedure organization context", () => {
	it("runs the handler inside withOrgContext for the resolved organization", async () => {
		reset();
		tenancy.resolveOrgForAuthentication.mockResolvedValue("org_a");
		const call = client(
			protectedProcedure.handler(({ context }) => ({
				inScope: tenancy.inScope,
				organizationId: (context as { organizationId?: string }).organizationId,
			})),
			authentication({ activeOrganizationId: "org_a" }),
		);
		await expect(call(undefined)).resolves.toEqual({ inScope: true, organizationId: "org_a" });
		expect(tenancy.resolveOrgForAuthentication).toHaveBeenCalledWith(
			expect.objectContaining({ method: "session", activeOrganizationId: "org_a" }),
			undefined,
		);
		expect(tenancy.withOrgContext).toHaveBeenCalledWith("org_a", expect.any(Function));
	});

	it("fails closed with FORBIDDEN when no organization resolves and never runs the handler", async () => {
		reset();
		tenancy.resolveOrgForAuthentication.mockResolvedValue(undefined);
		const handler = vi.fn(() => "executed");
		await expect(client(protectedProcedure.handler(handler), authentication())(undefined)).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "No active organization",
		});
		expect(handler).not.toHaveBeenCalled();
		expect(tenancy.withOrgContext).not.toHaveBeenCalled();
	});

	it("runs the handler without a scope when no organization resolves and enforcement is off", async () => {
		reset();
		tenancy.required = false;
		tenancy.resolveOrgForAuthentication.mockResolvedValue(undefined);
		const call = client(
			protectedProcedure.handler(({ context }) => ({
				inScope: tenancy.inScope,
				organizationId: (context as { organizationId?: string }).organizationId,
			})),
			authentication(),
		);
		await expect(call(undefined)).resolves.toEqual({ inScope: false, organizationId: undefined });
		expect(tenancy.withOrgContext).not.toHaveBeenCalled();
	});

	it("still scopes the handler when an organization resolves and enforcement is off", async () => {
		reset();
		tenancy.required = false;
		tenancy.resolveOrgForAuthentication.mockResolvedValue("org_a");
		const call = client(
			protectedProcedure.handler(() => tenancy.inScope),
			authentication(),
		);
		await expect(call(undefined)).resolves.toBe(true);
		expect(tenancy.withOrgContext).toHaveBeenCalledWith("org_a", expect.any(Function));
	});

	it("propagates handler errors out of the organization scope", async () => {
		reset();
		tenancy.resolveOrgForAuthentication.mockResolvedValue("org_a");
		const call = client(
			protectedProcedure.handler(() => {
				throw new Error("handler failed");
			}),
			authentication(),
		);
		await expect(call(undefined)).rejects.toThrow("handler failed");
		expect(tenancy.inScope).toBe(false);
	});

	it("still rejects an unauthenticated caller before resolving an organization", async () => {
		reset();
		await expect(
			client(
				protectedProcedure.handler(() => "x"),
				null,
			)(undefined),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(tenancy.resolveOrgForAuthentication).not.toHaveBeenCalled();
	});

	it("leaves the allow-listed procedure and public procedures free of an organization", async () => {
		reset();
		await expect(
			client(
				protectedProcedureWithoutOrg.handler(() => "ok"),
				authentication(),
			)(undefined),
		).resolves.toBe("ok");
		await expect(
			client(
				publicProcedure.handler(() => "ok"),
				null,
			)(undefined),
		).resolves.toBe("ok");
		expect(tenancy.resolveOrgForAuthentication).not.toHaveBeenCalled();
		expect(tenancy.withOrgContext).not.toHaveBeenCalled();
	});
});

describe("authentication carries the organization sources", () => {
	it("records the session's active organization", async () => {
		reset();
		authMock.api.getSession.mockResolvedValue({ user, session: { activeOrganizationId: "org_a" } });
		dbMock.select.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [user] }) }) });
		const result = await resolveAuthenticationFromRequestHeaders(new Headers({ cookie: "session=valid" }));
		expect(result).toMatchObject({ method: "session", activeOrganizationId: "org_a" });
	});

	it("records the verified API key's id and nothing from request headers", async () => {
		reset();
		authMock.api.verifyApiKey.mockResolvedValue({ valid: true, key: { id: "key_1", referenceId: "owner" } });
		dbMock.select.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [user] }) }) });
		const result = await resolveAuthenticationFromRequestHeaders(
			new Headers({ "x-api-key": "key", "x-organization-id": "org_evil" }),
		);
		expect(result).toMatchObject({ method: "apiKey", apiKeyId: "key_1" });
		expect(JSON.stringify(result)).not.toContain("org_evil");
	});
});

// CAREEROS (P2-T03)
describe("organization host", () => {
	const orgHost = {
		kind: "org" as const,
		organizationId: "org_a",
		slug: "a",
		via: "subdomain" as const,
		hostname: "a.example.com",
		origin: "https://a.example.com",
	};
	const hostClient = <T>(procedure: T, auth: unknown, host: unknown) =>
		createProcedureClient(procedure as never, {
			context: { locale: "en-US", reqHeaders: new Headers(), authentication: auth, host },
		}) as (input: undefined) => Promise<unknown>;

	it("hands the resolved host to the organization resolution", async () => {
		reset();
		tenancy.resolveOrgForAuthentication.mockResolvedValue("org_a");
		await hostClient(
			protectedProcedure.handler(() => "ok"),
			authentication({ activeOrganizationId: "org_b" }),
			orgHost,
		)(undefined);
		expect(tenancy.resolveOrgForAuthentication).toHaveBeenCalledWith(
			expect.objectContaining({ method: "session", activeOrganizationId: "org_b" }),
			orgHost,
		);
	});

	it("falls back to the host the server adapter registered for the request", async () => {
		reset();
		tenancy.registeredHost = orgHost;
		tenancy.resolveOrgForAuthentication.mockResolvedValue("org_a");
		await client(
			protectedProcedure.handler(() => "ok"),
			authentication(),
		)(undefined);
		expect(tenancy.resolveOrgForAuthentication).toHaveBeenCalledWith(expect.anything(), orgHost);
	});

	it.each([
		["not_member_of_host_org", "FORBIDDEN", "ORG_HOST_NOT_MEMBER"],
		["key_org_mismatch", "FORBIDDEN", "ORG_HOST_KEY_MISMATCH"],
	])("maps %s to %s with data.code %s and never runs the handler", async (reason, code, dataCode) => {
		reset();
		const { TenancyError } = await import("@careeros/tenancy");
		tenancy.resolveOrgForAuthentication.mockRejectedValue(
			new (TenancyError as never as new (c: string) => Error)(reason),
		);
		const handler = vi.fn(() => "executed");
		await expect(
			hostClient(protectedProcedure.handler(handler), authentication(), orgHost)(undefined),
		).rejects.toMatchObject({ code, data: { code: dataCode } });
		expect(handler).not.toHaveBeenCalled();
		expect(tenancy.withOrgContext).not.toHaveBeenCalled();
	});

	it("maps an unknown organization host to NOT_FOUND", async () => {
		reset();
		const { TenancyError } = await import("@careeros/tenancy");
		tenancy.resolveOrgForAuthentication.mockRejectedValue(
			new (TenancyError as never as new (c: string) => Error)("unknown_org_host"),
		);
		await expect(
			hostClient(
				protectedProcedure.handler(() => "x"),
				authentication(),
				{ kind: "unknown", matchesOrgPattern: true },
			)(undefined),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("trusts the origin of an organization host for cookie requests, and no other origin", async () => {
		reset();
		authMock.api.getSession.mockResolvedValue({ user, session: { activeOrganizationId: "org_a" } });
		const request = (origin: string) => new Headers({ cookie: "session=valid", origin });
		dbMock.select.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [user] }) }) });
		await expect(
			resolveAuthenticationFromRequestHeaders(request("https://a.example.com"), orgHost),
		).resolves.toMatchObject({ method: "session" });
		await expect(
			resolveAuthenticationFromRequestHeaders(request("https://b.example.com"), orgHost),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			resolveAuthenticationFromRequestHeaders(request("https://a.example.com"), { kind: "platform" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
