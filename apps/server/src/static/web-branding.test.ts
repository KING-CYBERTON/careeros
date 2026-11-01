import type { PublicBrandingInput } from "./brand-shell";
import type { HostContext } from "@careeros/tenancy";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// CAREEROS (P2-T02): how the app shell, the prerendered pages, the manifest and the unknown-organization page carry the
// host's brand. The host and the branding are fakes; the real resolver and database are covered elsewhere.
const mocks = vi.hoisted(() => ({
	env: { APP_URL: "https://platform.example" },
	serveStatic: vi.fn(() => vi.fn()),
}));

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("node:fs/promises", () => ({ default: { readFile: vi.fn() } }));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: mocks.serveStatic }));
vi.mock("@reactive-resume/env/server", () => ({ env: mocks.env }));

const { handleUnknownOrgHost, handleWebApp, handleWebManifest } = await import("./web");

const FILE = "logo-123e4567-e89b-12d3-a456-426614174000.png";
const ATTACK = `</script><script>alert(1)</script>"'&`;

const host = (organizationId = "org_acme"): HostContext => ({
	kind: "org",
	organizationId,
	slug: "acme",
	via: "subdomain",
	hostname: "acme.example",
	origin: "https://acme.example",
});

const branding = (overrides: Partial<PublicBrandingInput> = {}): PublicBrandingInput => ({
	organizationId: "org_acme",
	appName: "Acme Careers",
	logoUrl: `https://platform.example/api/branding-assets/org_acme/${FILE}`,
	faviconUrl: null,
	primaryColor: "#1a56db",
	secondaryColor: null,
	font: null,
	supportUrl: null,
	termsUrl: null,
	privacyUrl: null,
	...overrides,
});

const SHELL = `<!doctype html><html><head>
<title>Your career workspace | CareerOS</title>
<meta name="description" content="Your career workspace. Sign in or create an account.">
<link rel="icon" href="/favicon.ico">
</head><body><div id="app"></div><img src="/icon/light.svg" alt="CareerOS"></body></html>`;
const PRERENDERED = `<!doctype html><html><head>
<title>Your career workspace | CareerOS</title>
<meta name="description" content="Your career workspace. Sign in or create an account.">
</head><body><div id="app"><h1>Welcome to CareerOS</h1></div></body></html>`;

function files(map: Record<string, string>) {
	vi.mocked(fs.readFile).mockImplementation(async (path) => {
		const key = Object.keys(map).find((suffix) => String(path).endsWith(suffix));
		if (key === undefined) throw new Error(`ENOENT ${String(path)}`);
		return map[key] ?? "";
	});
}

const cspHashes = (response: Response) =>
	[...(response.headers.get("Content-Security-Policy") ?? "").matchAll(/'sha256-([^']+)'/g)].map((match) => match[1]);
const inlineScriptHashes = (html: string) =>
	[...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map(
		([, body]) =>
			createHash("sha256")
				.update(body ?? "")
				.digest("base64"),
	);

beforeEach(() => {
	vi.clearAllMocks();
	files({ "index.html": SHELL });
});

describe("handleWebApp on an organization host", () => {
	it("brands the shell and sends Vary: Host and the organization's cache tag", async () => {
		const load = vi.fn(async () => branding());
		const response = await handleWebApp(new Request("https://acme.example/dashboard"), undefined, host(), load);
		const html = await response.text();
		expect(load).toHaveBeenCalledExactlyOnceWith("org_acme");
		expect(html).toContain("<title>Your career workspace | Acme Careers</title>");
		expect(html).toContain('window.__BRAND__={"appName":"Acme Careers"');
		expect(html).toContain("--accent:#1a56db");
		expect(html).toContain(`<img src="/api/branding-assets/org_acme/${FILE}" alt="Acme Careers">`);
		expect(html).not.toContain("CareerOS");
		expect(response.headers.get("Vary")).toBe("Host");
		expect(response.headers.get("Cache-Tag")).toBe("html,org-org_acme");
		expect(response.headers.get("Cache-Control")).toBeNull();
	});

	it("allows exactly the page's inline scripts, brand script included, by hash", async () => {
		const response = await handleWebApp(new Request("https://acme.example/dashboard"), undefined, host(), async () =>
			branding({ appName: ATTACK }),
		);
		const html = await response.text();
		expect(cspHashes(response).sort()).toEqual(inlineScriptHashes(html).sort());
		expect(cspHashes(response)).toHaveLength(1);
	});

	it("renders a hostile app name inert", async () => {
		const response = await handleWebApp(new Request("https://acme.example/dashboard"), undefined, host(), async () =>
			branding({ appName: ATTACK }),
		);
		const html = await response.text();
		expect(html).not.toContain("<script>alert(1)");
		expect(html).not.toContain(ATTACK);
		expect(html.match(/<script/g)).toHaveLength(1);
		expect(html).toContain(
			"<title>Your career workspace | &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;</title>",
		);
	});

	it("brands the prerendered landing page at serve time, adds SEO tags on the organization's own address", async () => {
		files({ "index.html": SHELL, "/home/en-US.html": PRERENDERED });
		const response = await handleWebApp(new Request("https://acme.example/"), undefined, host(), async () =>
			branding(),
		);
		const html = await response.text();
		expect(html).toContain("<h1>Welcome to Acme Careers</h1>");
		expect(html).not.toContain("CareerOS");
		expect(html).toContain('<meta property="og:site_name" content="Acme Careers">');
		expect(html).toContain('<link rel="canonical" href="https://acme.example/">');
		expect(html).toContain('"name":"Acme Careers"');
		expect(html).toContain('window.__BRAND__={"appName":"Acme Careers"');
		expect(response.headers.get("Vary")).toBe("Cookie, Host");
		expect(response.headers.get("Cache-Tag")).toBe("html,org-org_acme");
		expect(cspHashes(response).sort()).toEqual(inlineScriptHashes(html).sort());
	});

	it("serves the prerendered page unbranded to nobody: two hosts never share a rendering", async () => {
		files({ "index.html": SHELL, "/home/en-US.html": PRERENDERED });
		const acme = await (
			await handleWebApp(new Request("https://acme.example/"), undefined, host(), async () => branding())
		).text();
		const other = await (
			await handleWebApp(new Request("https://beta.example/"), undefined, host("org_beta"), async () =>
				branding({ organizationId: "org_beta", appName: "Beta Jobs" }),
			)
		).text();
		expect(acme).toContain("Acme Careers");
		expect(acme).not.toContain("Beta Jobs");
		expect(other).toContain("Beta Jobs");
		expect(other).not.toContain("Acme Careers");
	});

	it("serves the platform default, uncacheable, when the branding cannot be loaded", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const response = await handleWebApp(new Request("https://acme.example/dashboard"), undefined, host(), async () => {
			throw new Error("db down");
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("<title>Your career workspace | CareerOS</title>");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Vary")).toBe("Host");
	});

	it("answers HEAD with Vary: Host without reading the shell", async () => {
		const response = await handleWebApp(
			new Request("https://acme.example/", { method: "HEAD" }),
			undefined,
			host(),
			async () => branding(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Vary")).toBe("Host");
		expect(fs.readFile).not.toHaveBeenCalled();
	});
});

describe("handleWebApp on the platform host", () => {
	it("never asks for branding and holds the defaults", async () => {
		const load = vi.fn();
		const response = await handleWebApp(
			new Request("https://platform.example/dashboard"),
			undefined,
			{ kind: "platform" },
			load,
		);
		const html = await response.text();
		expect(load).not.toHaveBeenCalled();
		expect(html).toContain("<title>Your career workspace | CareerOS</title>");
		expect(html).toContain('window.__BRAND__={"appName":"CareerOS"};');
		expect(html).not.toContain('<style id="brand">');
		expect(response.headers.get("Vary")).toBe("Host");
		expect(response.headers.get("Cache-Tag")).toBe("html");
	});
});

describe("handleUnknownOrgHost", () => {
	it("answers 404 with the neutral not-set-up shell and no branding", async () => {
		const response = await handleUnknownOrgHost();
		const html = await response.text();
		expect(response.status).toBe(404);
		expect(html).toContain("<title>This address isn&#39;t set up yet</title>");
		expect(html).toContain("window.__ORG_NOT_FOUND__=true;");
		expect(html).toContain('window.__BRAND__={"appName":"CareerOS"};');
		expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Vary")).toBe("Host");
		expect(cspHashes(response).sort()).toEqual(inlineScriptHashes(html).sort());
	});
});

describe("handleWebManifest", () => {
	const MANIFEST = JSON.stringify({
		name: "CareerOS",
		short_name: "CareerOS",
		theme_color: "#F8F7F3",
		icons: [],
		start_url: "/dashboard",
	});

	it("builds the manifest from the host's branding and varies on Host", async () => {
		files({ "manifest.webmanifest": MANIFEST });
		const response = await handleWebManifest(host(), undefined, async () => branding());
		const manifest = await response.json();
		expect(manifest).toMatchObject({ name: "Acme Careers", short_name: "Acme Careers", theme_color: "#1a56db" });
		expect(manifest.icons[0].src).toBe(`/api/branding-assets/org_acme/${FILE}`);
		expect(response.headers.get("Content-Type")).toContain("application/manifest+json");
		expect(response.headers.get("Vary")).toBe("Host");
		expect(response.headers.get("Cache-Tag")).toBe("public,org-org_acme");
	});

	it("keeps the platform manifest on the platform host", async () => {
		files({ "manifest.webmanifest": MANIFEST });
		const response = await handleWebManifest({ kind: "platform" });
		expect(await response.json()).toMatchObject({ name: "CareerOS", theme_color: "#F8F7F3" });
		expect(response.headers.get("Cache-Tag")).toBe("public");
	});
});
