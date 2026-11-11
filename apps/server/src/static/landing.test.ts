import type { HostContext } from "@careeros/tenancy";
import { describe, expect, it, vi } from "vite-plus/test";

// CAREEROS (P6-M02): the marketing pages answer at clean addresses on the platform host only.
const env = vi.hoisted(() => ({ APP_URL: "https://platform.example/", APP_REVISION: undefined as string | undefined }));
vi.mock("@reactive-resume/env/server", () => ({ env }));
vi.mock("./web", () => ({
	webDistRoot: "/dist",
	BASE_SECURITY_HEADERS: { "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'" },
}));

const { handleLandingPage, landingRedirect, LANDING_PATHS } = await import("./landing");

const orgHost: HostContext = {
	kind: "org",
	organizationId: "org_acme",
	slug: "acme",
	via: "subdomain",
	hostname: "acme.example",
	origin: "https://acme.example",
};
const page = (path: string) => `<html><head><title>${path}</title></head><body></body></html>`;

describe("handleLandingPage", () => {
	it("serves the home page and the organisations page from the site folder of the web build", async () => {
		const readFile = vi.fn(async (path: string) => page(path));

		const home = await handleLandingPage("/", { kind: "platform" }, readFile);
		const organisations = await handleLandingPage("/organisations", { kind: "platform" }, readFile);

		expect(await home?.text()).toContain("<title>/dist/site/index.html</title>");
		expect(await organisations?.text()).toContain("<title>/dist/site/organisations.html</title>");
		expect(LANDING_PATHS).toEqual(["/", "/organisations"]);
	});

	it("adds the canonical link and the share card's address for this deployment", async () => {
		const home = await (await handleLandingPage("/", { kind: "platform" }, async () => page("home")))?.text();
		const organisations = await (
			await handleLandingPage("/organisations", { kind: "platform" }, async () => page("org"))
		)?.text();

		expect(home).toContain('<link rel="canonical" href="https://platform.example/">');
		expect(home).toContain('<meta property="og:image" content="https://platform.example/opengraph/banner.jpg">');
		expect(organisations).toContain('<link rel="canonical" href="https://platform.example/organisations">');
		expect(organisations).toContain('<meta property="og:url" content="https://platform.example/organisations">');
	});

	it("adds the build's revision to the site folder's stylesheets and scripts, once", async () => {
		const html = `<html><head><link rel="stylesheet" href="/site/assets/system.css"><script src="/site/tiles.js?v=abc"></script><a href="/organisations">o</a></head></html>`;
		const read = async () => html;

		expect(await (await handleLandingPage("/", { kind: "platform" }, read))?.text()).toContain(
			'href="/site/assets/system.css">',
		);

		env.APP_REVISION = "0123456789abcdef0123";
		const versioned = await (await handleLandingPage("/", { kind: "platform" }, read))?.text();
		env.APP_REVISION = undefined;

		expect(versioned).toContain('href="/site/assets/system.css?v=0123456789ab"');
		expect(versioned).toContain('src="/site/tiles.js?v=abc"');
		expect(versioned).toContain('href="/organisations"');
	});

	it("sends the security headers and lets search engines index the page", async () => {
		const response = await handleLandingPage("/", { kind: "platform" }, async () => page("home"));

		expect(response?.status).toBe(200);
		expect(response?.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
		expect(response?.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
		expect(response?.headers.get("X-Frame-Options")).toBe("DENY");
		expect(response?.headers.get("X-Robots-Tag")).toBeNull();
		expect(response?.headers.get("Cache-Control")).toBe("no-cache");
	});

	it("shows nothing on an organization's address", async () => {
		const readFile = vi.fn(async () => page("home"));

		expect(await handleLandingPage("/", orgHost, readFile)).toBeNull();
		expect(await handleLandingPage("/organisations", orgHost, readFile)).toBeNull();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("falls through for other addresses and for a build without the pages", async () => {
		const missing = vi.fn(async (): Promise<string> => {
			throw new Error("ENOENT");
		});

		expect(await handleLandingPage("/pricing", { kind: "platform" }, async () => "x")).toBeNull();
		expect(await handleLandingPage("/", { kind: "platform" }, missing)).toBeNull();
	});
});

describe("landingRedirect", () => {
	it("moves a page's file name to the page's address", () => {
		expect(landingRedirect("/site/index.html")).toBe("/");
		expect(landingRedirect("/site/organisations.html")).toBe("/organisations");
		expect(landingRedirect("/site")).toBe("/");
		expect(landingRedirect("/site/")).toBe("/");
	});

	it("moves every address under the retired /landing folder", () => {
		expect(landingRedirect("/landing/index.html")).toBe("/");
		expect(landingRedirect("/landing/organisations.html")).toBe("/organisations");
		expect(landingRedirect("/landing/tiles.js")).toBe("/");
	});

	it("leaves the folder's stylesheets, scripts and fonts alone", () => {
		expect(landingRedirect("/site/tiles.js")).toBeNull();
		expect(landingRedirect("/site/assets/system.css")).toBeNull();
		expect(landingRedirect("/site/fonts/figtree-latin-wght-normal.woff2")).toBeNull();
		expect(landingRedirect("/dashboard")).toBeNull();
	});
});
