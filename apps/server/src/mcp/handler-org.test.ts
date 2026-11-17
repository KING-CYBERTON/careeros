import { beforeEach, expect, it, vi } from "vite-plus/test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mocks = vi.hoisted(() => ({
	authentication: vi.fn(),
	limit: vi.fn(),
	resolveOrg: vi.fn(),
	resolveHost: vi.fn(),
	withOrg: vi.fn(),
	inScope: false,
	required: true,
}));
vi.mock("@reactive-resume/env/server", () => ({ env: { APP_URL: "https://resume.example" } }));
vi.mock("@reactive-resume/api/context", () => ({ resolveAuthenticationFromRequestHeaders: mocks.authentication }));
vi.mock("@reactive-resume/api/features/mcp/transport", () => ({
	consumeMcpRequestLimit: mocks.limit,
	consumeMcpUserLimit: mocks.limit,
}));
// Declared here, this mock replaces the shared one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", () => ({
	get ORG_CONTEXT_REQUIRED() {
		return mocks.required;
	},
	resolveOrgForAuthentication: mocks.resolveOrg,
	withOrgContext: mocks.withOrg,
	// P2-T03
	resolveHost: mocks.resolveHost,
	TenancyError: class TenancyError extends Error {
		readonly code: string;
		constructor(code: string) {
			super(code);
			this.code = code;
		}
	},
}));
const createServer = vi.hoisted(() => vi.fn());
vi.mock("./server", () => ({ createMcpServer: createServer }));

import { handleMcp } from "./handler";

const authentication = { user: { id: "user-1" }, method: "apiKey", permissions: ["read"], apiKeyId: "key-1" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.limit.mockResolvedValue(undefined);
	mocks.authentication.mockResolvedValue(authentication);
	mocks.inScope = false;
	mocks.required = true;
	mocks.resolveHost.mockResolvedValue({ kind: "platform" });
	mocks.withOrg.mockImplementation(async (_org: string, fn: () => Promise<unknown>) => {
		mocks.inScope = true;
		try {
			return await fn();
		} finally {
			mocks.inScope = false;
		}
	});
	createServer.mockImplementation(() => new McpServer({ name: "transport-test", version: "1.0.0" }));
});

const initialize = () =>
	new Request("https://resume.example/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			// A caller-supplied organization must never matter.
			"X-Organization-Id": "org_evil",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
		}),
	});

it("handles the request inside the organization resolved from the authentication", async () => {
	mocks.resolveOrg.mockResolvedValue("org_a");
	const response = await handleMcp(initialize(), "127.0.0.1");
	expect(response.status).toBe(200);
	expect(mocks.resolveOrg).toHaveBeenCalledWith(authentication, { kind: "platform" });
	expect(mocks.withOrg).toHaveBeenCalledWith("org_a", expect.any(Function));
	expect(mocks.inScope).toBe(false);
});

it("refuses the request with 403 when no organization resolves", async () => {
	mocks.resolveOrg.mockResolvedValue(undefined);
	const response = await handleMcp(initialize(), "127.0.0.1");
	expect(response.status).toBe(403);
	expect(await response.text()).toContain("No active organization");
	expect(mocks.withOrg).not.toHaveBeenCalled();
	expect(createServer).not.toHaveBeenCalled();
});

it("handles the request without a scope when no organization resolves and enforcement is off", async () => {
	mocks.required = false;
	mocks.resolveOrg.mockResolvedValue(undefined);
	const response = await handleMcp(initialize(), "127.0.0.1");
	expect(response.status).toBe(200);
	expect(mocks.withOrg).not.toHaveBeenCalled();
});

it("conceals a failure raised inside the organization scope", async () => {
	mocks.resolveOrg.mockResolvedValue("org_a");
	mocks.withOrg.mockRejectedValue(new Error("private detail"));
	const response = await handleMcp(initialize(), "127.0.0.1");
	expect(response.status).toBe(500);
	expect(await response.text()).not.toContain("private detail");
});

// CAREEROS (P2-T03): the request host decides the organization.
const orgHost = {
	kind: "org",
	organizationId: "org_a",
	slug: "a",
	via: "subdomain",
	hostname: "a.example.test",
	origin: "https://a.example.test",
};

it("hands the resolved host to the organization resolution", async () => {
	mocks.resolveHost.mockResolvedValue(orgHost);
	mocks.resolveOrg.mockResolvedValue("org_a");
	const response = await handleMcp(initialize(), "127.0.0.1");
	expect(response.status).toBe(200);
	expect(mocks.resolveOrg).toHaveBeenCalledWith(authentication, orgHost);
	expect(mocks.withOrg).toHaveBeenCalledWith("org_a", expect.any(Function));
});

it("uses the host given by the server adapter without resolving it again", async () => {
	mocks.resolveOrg.mockResolvedValue("org_a");
	await handleMcp(initialize(), "127.0.0.1", orgHost as never);
	expect(mocks.resolveHost).not.toHaveBeenCalled();
	expect(mocks.resolveOrg).toHaveBeenCalledWith(authentication, orgHost);
});

it.each([
	["not_member_of_host_org", 403],
	["key_org_mismatch", 403],
	["unknown_org_host", 404],
])("answers %s with %i and never runs the server", async (code, status) => {
	const { TenancyError } = await import("@careeros/tenancy");
	mocks.resolveHost.mockResolvedValue(orgHost);
	mocks.resolveOrg.mockRejectedValue(new (TenancyError as never as new (c: string) => Error)(code));
	const response = await handleMcp(initialize(), "127.0.0.1");
	expect(response.status).toBe(status);
	expect(createServer).not.toHaveBeenCalled();
	expect(mocks.withOrg).not.toHaveBeenCalled();
});

it("accepts the origin of an organization host and refuses any other", async () => {
	mocks.resolveHost.mockResolvedValue(orgHost);
	mocks.resolveOrg.mockResolvedValue("org_a");
	const withOrigin = (origin: string) => {
		const request = initialize();
		request.headers.set("origin", origin);
		return request;
	};
	expect((await handleMcp(withOrigin("https://a.example.test"), "127.0.0.1")).status).toBe(200);
	expect((await handleMcp(withOrigin("https://b.example.test"), "127.0.0.1")).status).toBe(403);
	mocks.resolveHost.mockResolvedValue({ kind: "platform" });
	expect((await handleMcp(withOrigin("https://a.example.test"), "127.0.0.1")).status).toBe(403);
});
