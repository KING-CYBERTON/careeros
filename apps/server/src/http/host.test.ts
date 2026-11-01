import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";

// CAREEROS (P2-T03): the host middleware. Declared here, this mock replaces the shared one from vitest.org.setup.ts.
const mocks = vi.hoisted(() => ({ resolveHost: vi.fn(), seen: vi.fn() }));
vi.mock("@careeros/tenancy", async () => {
	const { AsyncLocalStorage } = await import("node:async_hooks");
	const store = new AsyncLocalStorage<unknown>();
	return {
		resolveHost: mocks.resolveHost,
		runWithHost: (host: unknown, fn: () => unknown) => store.run(host, fn),
		currentHost: () => store.getStore(),
	};
});
vi.mock("../static/web", () => ({
	handleUnknownOrgHost: async () => new Response("<html>shell</html>", { status: 404 }),
}));

const { hostMiddleware } = await import("./host");
const { currentHost } = await import("@careeros/tenancy");

const makeApp = () => {
	const app = new Hono<{ Variables: { host: unknown } }>();
	app.use("*", hostMiddleware());
	app.all("*", (c) => {
		mocks.seen({ variable: c.get("host"), scoped: currentHost() });
		return c.text("ok");
	});
	return app;
};

const orgHost = {
	kind: "org",
	organizationId: "org_a",
	slug: "a",
	via: "subdomain",
	hostname: "a.test",
	origin: "https://a.test",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("hostMiddleware", () => {
	it("puts the resolved host on the context and in the request scope", async () => {
		mocks.resolveHost.mockResolvedValue(orgHost);
		const response = await makeApp().request("https://a.test/api/rpc/x");
		expect(response.status).toBe(200);
		expect(mocks.seen).toHaveBeenCalledWith({ variable: orgHost, scoped: orgHost });
	});

	it("resolves the host once per request", async () => {
		mocks.resolveHost.mockResolvedValue({ kind: "platform" });
		await makeApp().request("https://app.test/");
		expect(mocks.resolveHost).toHaveBeenCalledTimes(1);
	});

	it("answers 404 JSON on /api for a host that looks like an organization host but is unknown", async () => {
		mocks.resolveHost.mockResolvedValue({ kind: "unknown", matchesOrgPattern: true });
		const response = await makeApp().request("https://nobody.test/api/rpc/resume/list");
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toMatchObject({ code: "NOT_FOUND", status: 404 });
		expect(mocks.seen).not.toHaveBeenCalled();
	});

	it("answers 404 with the app shell for every other path of such a host", async () => {
		mocks.resolveHost.mockResolvedValue({ kind: "unknown", matchesOrgPattern: true });
		const response = await makeApp().request("https://nobody.test/auth/login");
		expect(response.status).toBe(404);
		expect(await response.text()).toContain("shell");
		expect(mocks.seen).not.toHaveBeenCalled();
	});

	it("leaves a host that does not look like an organization host alone", async () => {
		mocks.resolveHost.mockResolvedValue({ kind: "unknown", matchesOrgPattern: false });
		const response = await makeApp().request("https://cv.someone.dev/");
		expect(response.status).toBe(200);
		expect(mocks.seen).toHaveBeenCalledOnce();
	});
});
