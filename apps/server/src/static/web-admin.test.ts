import type { PublicBrandingInput } from "./brand-shell";
import type { HostContext } from "@careeros/tenancy";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// CAREEROS (P3-T07): the Super Admin console's pages exist on the platform host only; every other host answers 404,
// decided from the resolved host.
const mocks = vi.hoisted(() => ({
	env: { APP_URL: "https://platform.example" },
	serveStatic: vi.fn(() => vi.fn()),
}));

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("node:fs/promises", () => ({ default: { readFile: vi.fn() } }));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: mocks.serveStatic }));
vi.mock("@reactive-resume/env/server", () => ({ env: mocks.env }));

const { handleWebApp } = await import("./web");

const SHELL = `<!doctype html><html><head><title>Your career workspace | CareerOS</title>
<meta name="description" content="Your career workspace."></head><body><div id="app"></div></body></html>`;

const orgHost: Extract<HostContext, { kind: "org" }> = {
	kind: "org",
	organizationId: "org_acme",
	slug: "acme",
	via: "subdomain",
	hostname: "acme.example",
	origin: "https://acme.example",
};
const branding = async (): Promise<PublicBrandingInput> => ({
	organizationId: "org_acme",
	appName: "Acme Careers",
	logoUrl: null,
	faviconUrl: null,
	primaryColor: null,
	secondaryColor: null,
	font: null,
	supportUrl: null,
	termsUrl: null,
	privacyUrl: null,
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(fs.readFile).mockImplementation(async (path) => {
		if (String(path).endsWith("index.html")) return SHELL;
		throw new Error(`ENOENT ${String(path)}`);
	});
});

describe("handleWebApp and the /admin console", () => {
	it.each([
		["an organization host", orgHost],
		["a custom domain", { ...orgHost, via: "custom" as const, hostname: "jobs.acme.example" }],
		["an unknown host", { kind: "unknown", matchesOrgPattern: false } as HostContext],
	])("answers 404 for /admin and everything below it on %s", async (_name, host) => {
		for (const path of ["/admin", "/admin/", "/admin/organizations", "/admin/organizations/org_acme"]) {
			const response = await handleWebApp(new Request(`https://acme.example${path}`), undefined, host, branding);
			expect(response.status, path).toBe(404);
			expect(await response.text(), path).not.toContain('id="app"');
		}
	});

	it("serves the app shell for /admin on the platform host", async () => {
		const response = await handleWebApp(new Request("https://platform.example/admin/organizations"), undefined, {
			kind: "platform",
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('id="app"');
	});

	it("still serves the member's own dashboard on an organization host", async () => {
		const response = await handleWebApp(new Request("https://acme.example/dashboard"), undefined, orgHost, branding);
		expect(response.status).toBe(200);
	});
});
