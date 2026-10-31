import { beforeEach, expect, it, vi } from "vite-plus/test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mocks = vi.hoisted(() => ({
	authentication: vi.fn(),
	limit: vi.fn(),
	resolveOrg: vi.fn(),
	withOrg: vi.fn(),
	inScope: false,
}));
vi.mock("@reactive-resume/env/server", () => ({ env: { APP_URL: "https://resume.example" } }));
vi.mock("@reactive-resume/api/context", () => ({ resolveAuthenticationFromRequestHeaders: mocks.authentication }));
vi.mock("@reactive-resume/api/features/mcp/transport", () => ({
	consumeMcpRequestLimit: mocks.limit,
	consumeMcpUserLimit: mocks.limit,
}));
// Declared here, this mock replaces the shared one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", () => ({
	resolveOrgForAuthentication: mocks.resolveOrg,
	withOrgContext: mocks.withOrg,
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
	expect(mocks.resolveOrg).toHaveBeenCalledWith(authentication);
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

it("conceals a failure raised inside the organization scope", async () => {
	mocks.resolveOrg.mockResolvedValue("org_a");
	mocks.withOrg.mockRejectedValue(new Error("private detail"));
	const response = await handleMcp(initialize(), "127.0.0.1");
	expect(response.status).toBe(500);
	expect(await response.text()).not.toContain("private detail");
});
