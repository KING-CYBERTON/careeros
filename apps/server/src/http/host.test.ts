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
// CAREEROS (P2-Q01): `serveWebDistStatic` stands in for the built files: only /assets/app.js and /icon/light.svg exist.
vi.mock("../static/web", () => ({
	handleUnknownOrgHost: async () => new Response("<html>shell</html>", { status: 404 }),
	serveWebDistStatic: async (c: { req: { path: string } }, next: () => Promise<void>) => {
		if (["/assets/app.js", "/icon/light.svg"].includes(c.req.path)) return new Response("file", { status: 200 });
		await next();
		return undefined;
	},
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

	it("serves the built web files on such a host, so the not-set-up page can start, and nothing else", async () => {
		mocks.resolveHost.mockResolvedValue({ kind: "unknown", matchesOrgPattern: true });
		const app = makeApp();
		const script = await app.request("https://nobody.test/assets/app.js");
		expect(script.status).toBe(200);
		expect(await script.text()).toBe("file");
		expect((await app.request("https://nobody.test/icon/light.svg")).status).toBe(200);
		// A static path with no file is a plain 404, not the shell (a script request must not get HTML).
		const missing = await app.request("https://nobody.test/assets/missing.js");
		expect(missing.status).toBe(404);
		expect(await missing.text()).toBe("Not Found");
		// Everything with organization data or behaviour is still closed, including look-alikes.
		for (const path of [
			"/api/branding-assets/org_a/logo-x.png",
			"/api/rpc/resume/list",
			"/manifest.webmanifest",
			"/uploads/x.png",
			"/assets",
			"/assetsx/app.js",
			"/some-user/some-resume",
		]) {
			const response = await app.request(`https://nobody.test${path}`);
			expect(response.status, path).toBe(404);
			expect(await response.text(), path).not.toBe("file");
		}
		expect(mocks.seen).not.toHaveBeenCalled();
	});

	it("leaves a host that does not look like an organization host alone", async () => {
		mocks.resolveHost.mockResolvedValue({ kind: "unknown", matchesOrgPattern: false });
		const response = await makeApp().request("https://cv.someone.dev/");
		expect(response.status).toBe(200);
		expect(mocks.seen).toHaveBeenCalledOnce();
	});
});
