import { describe, expect, it, vi } from "vite-plus/test";
import {
	applyBrand,
	loadShellBrand,
	PLATFORM_SHELL_BRAND,
	renderBrandCss,
	renderManifest,
	serializeForInlineScript,
	shellBrandFromPublic,
	shellCacheTags,
	varyOn,
	type PublicBrandingInput,
} from "./brand-shell";

const FILE = "logo-123e4567-e89b-12d3-a456-426614174000.png";
const FAVICON = "favicon-123e4567-e89b-12d3-a456-426614174001.png";
const ATTACK = `</script><script>alert(1)</script>" onload="x' & <b>`;

const branding = (overrides: Partial<PublicBrandingInput> = {}): PublicBrandingInput => ({
	organizationId: "org_acme",
	appName: "Acme Careers",
	logoUrl: `https://platform.example/api/branding-assets/org_acme/${FILE}`,
	faviconUrl: `https://platform.example/api/branding-assets/org_acme/${FAVICON}`,
	primaryColor: "#1a56db",
	secondaryColor: "#ffd400",
	font: "Inter",
	supportUrl: "https://acme.example/help",
	termsUrl: null,
	privacyUrl: "https://acme.example/privacy",
	...overrides,
});

const SHELL = `<!doctype html><html><head>
<meta name="theme-color" content="#F8F7F3" media="(prefers-color-scheme: light)" />
<meta name="application-name" content="CareerOS" />
<link rel="icon" href="/favicon.ico" type="image/x-icon" sizes="128x128" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="256x256 any" />
<link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png" type="image/png" sizes="180x180 any" />
<title>Your career workspace | CareerOS</title></head>
<body><div id="app"></div><img src="/icon/light.svg" alt="CareerOS"><img src="/icon/dark.svg" alt="">
<script>const platform = "CareerOS";</script></body></html>`;

describe("shellBrandFromPublic", () => {
	it("maps branding to a brand with asset paths on the serving host", () => {
		const { brand, organizationId } = shellBrandFromPublic(branding());
		expect(organizationId).toBe("org_acme");
		expect(brand).toEqual({
			appName: "Acme Careers",
			logoUrl: `/api/branding-assets/org_acme/${FILE}`,
			faviconUrl: `/api/branding-assets/org_acme/${FAVICON}`,
			supportUrl: "https://acme.example/help",
			privacyUrl: "https://acme.example/privacy",
			primaryColor: "#1a56db",
			secondaryColor: "#ffd400",
			font: "Inter",
		});
	});

	it("drops anything that is not valid, even though T01 validated it", () => {
		const { brand } = shellBrandFromPublic(
			branding({
				logoUrl: "https://evil.example/logo.png",
				faviconUrl: "javascript:alert(1)",
				primaryColor: "red;}</style><script>",
				secondaryColor: "#12345",
				font: "Comic Sans",
				supportUrl: "http://acme.example",
				termsUrl: "javascript:alert(1)",
				privacyUrl: "https://user:pass@acme.example",
			}),
		);
		expect(brand).toEqual({ appName: "Acme Careers" });
	});

	it("uses the platform name for a missing name and caps a long one", () => {
		expect(shellBrandFromPublic(branding({ appName: null })).brand.appName).toBe("CareerOS");
		expect(shellBrandFromPublic(branding({ appName: "x".repeat(200) })).brand.appName).toHaveLength(60);
	});
});

describe("loadShellBrand", () => {
	const org = {
		kind: "org",
		organizationId: "org_acme",
		slug: "acme",
		via: "subdomain",
		hostname: "acme.example",
		origin: "https://acme.example",
	} as const;

	it("uses the platform default for platform and unknown hosts without asking for branding", async () => {
		const load = vi.fn();
		expect(await loadShellBrand({ kind: "platform" }, load)).toBe(PLATFORM_SHELL_BRAND);
		expect(await loadShellBrand({ kind: "unknown", matchesOrgPattern: false }, load)).toBe(PLATFORM_SHELL_BRAND);
		expect(load).not.toHaveBeenCalled();
	});

	it("loads the branding of the organization the host resolved to, and only that one", async () => {
		const load = vi.fn(async () => branding());
		const shell = await loadShellBrand(org, load);
		expect(load).toHaveBeenCalledExactlyOnceWith("org_acme");
		expect(shell.brand.appName).toBe("Acme Careers");
	});

	it("falls back to the default, marked degraded, when the lookup fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const shell = await loadShellBrand(org, async () => {
			throw new Error("db down");
		});
		expect(shell.degraded).toBe(true);
		expect(shell.brand.appName).toBe("CareerOS");
		expect(shellCacheTags(shell)).toBe("html,org-org_acme");
	});
});

describe("serializeForInlineScript", () => {
	it("escapes everything that could end a script or a line", () => {
		const out = serializeForInlineScript({ a: `</script><!--&\u2028\u2029` });
		expect(out).not.toMatch(/[<>&\u2028\u2029]/);
		expect(JSON.parse(out)).toEqual({ a: `</script><!--&\u2028\u2029` });
	});
});

describe("renderBrandCss", () => {
	it("is empty for the platform default", () => {
		expect(renderBrandCss({ appName: "CareerOS" })).toBe("");
	});

	it("maps the colours and font onto the theme tokens, for light and dark", () => {
		const css = renderBrandCss(shellBrandFromPublic(branding()).brand);
		expect(css).toContain("--accent:#1a56db");
		expect(css).toContain("--on-accent:#ffffff");
		expect(css).toMatch(/--accent-hover:#[0-9a-f]{6}/);
		expect(css).toMatch(/--accent-soft:#[0-9a-f]{6}/);
		expect(css).toMatch(/--accent-text:#[0-9a-f]{6}/);
		expect(css).toContain(":root.dark{--accent:");
		expect(css).toContain("--brand-secondary:#ffd400");
		expect(css).toContain("--brand-on-secondary:#000000");
		expect(css).toContain('--font-ui:"Inter","Figtree Variable",system-ui,sans-serif');
		expect(css).toMatch(/@font-face\{font-family:"Inter";[^}]*src:url\("https:\/\/fonts\.gstatic\.com\//);
		expect(css).not.toMatch(/[<>]/);
	});

	it("leaves the UI font alone for Figtree and uses a serif fallback for serif fonts", () => {
		expect(renderBrandCss({ appName: "A", font: "Figtree" })).toBe("");
		expect(renderBrandCss({ appName: "A", font: "Lora" })).toContain("Georgia,serif");
	});

	it("ignores values outside the allowed formats", () => {
		expect(renderBrandCss({ appName: "A", primaryColor: "red;}", font: "x;}" })).toBe("");
	});
});

describe("applyBrand", () => {
	it("brands title, name, icons, loader logo, theme colour and adds the style and script", () => {
		const html = applyBrand(SHELL, shellBrandFromPublic(branding()));
		expect(html).toContain("<title>Your career workspace | Acme Careers</title>");
		expect(html).toContain('<meta name="application-name" content="Acme Careers" />');
		expect(html).toContain(`<link rel="icon" href="/api/branding-assets/org_acme/${FAVICON}" type="image/png">`);
		expect(html).toContain(`<link rel="apple-touch-icon" href="/api/branding-assets/org_acme/${FAVICON}">`);
		expect(html).not.toContain('href="/favicon.svg"');
		expect(html.match(/rel="icon"/g)).toHaveLength(1);
		expect(html).toContain(`<img src="/api/branding-assets/org_acme/${FILE}" alt="Acme Careers">`);
		expect(html).toContain('content="#1a56db" media="(prefers-color-scheme: light)"');
		expect(html).toContain('<style id="brand">');
		expect(html).toContain('window.__BRAND__={"appName":"Acme Careers"');
		expect(html.indexOf('<style id="brand">')).toBeLessThan(html.indexOf("</head>"));
		// Script bodies are code, not text.
		expect(html).toContain('const platform = "CareerOS";');
	});

	it("keeps the platform shell as is apart from the script block holding the defaults", () => {
		const html = applyBrand(SHELL, PLATFORM_SHELL_BRAND);
		expect(html).toBe(SHELL.replace("</head>", '<script>window.__BRAND__={"appName":"CareerOS"};</script></head>'));
	});

	it("renders a hostile app name inert in every position", () => {
		const html = applyBrand(SHELL, shellBrandFromPublic(branding({ appName: ATTACK.slice(0, 60) })));
		const name = ATTACK.slice(0, 60);
		// The only scripts are the page's own and the brand block; none was opened by the name.
		expect(html.match(/<script/g)).toHaveLength(2);
		expect(html).not.toContain("<script>alert(1)");
		expect(html).not.toContain(name);
		const script = /<script>window\.__BRAND__=(.*?);<\/script>/.exec(html);
		expect(script).not.toBeNull();
		expect(JSON.parse(script?.[1] ?? "").appName).toBe(name);
		expect(html).toContain('<meta name="application-name" content="&lt;/script&gt;');
		expect(html).toContain("&quot; onload=&quot;x&#39; &amp; &lt;b&gt;");
		expect(html).toContain("<title>Your career workspace | &lt;/script&gt;");
	});

	it("keeps $ patterns in a name literal", () => {
		const html = applyBrand(SHELL, shellBrandFromPublic(branding({ appName: "A$&B$'C" })));
		expect(html).toContain("<title>Your career workspace | A$&amp;B$&#39;C</title>");
	});

	it("passes an unbranded document without a head through", () => {
		expect(applyBrand("<html>app</html>", PLATFORM_SHELL_BRAND)).toBe("<html>app</html>");
	});
});

describe("varyOn and shellCacheTags", () => {
	it("adds Host once", () => {
		expect(varyOn(undefined)).toBe("Host");
		expect(varyOn("Cookie")).toBe("Cookie, Host");
		expect(varyOn("cookie, host")).toBe("cookie, host");
	});

	it("tags an organization page with its own tag, only for safe ids", () => {
		expect(shellCacheTags(PLATFORM_SHELL_BRAND)).toBe("html");
		expect(shellCacheTags({ ...PLATFORM_SHELL_BRAND, organizationId: "org_acme" })).toBe("html,org-org_acme");
		expect(shellCacheTags({ ...PLATFORM_SHELL_BRAND, organizationId: "a,b" })).toBe("html");
	});
});

describe("renderManifest", () => {
	const base = JSON.stringify({
		name: "CareerOS",
		short_name: "CareerOS",
		theme_color: "#F8F7F3",
		icons: [{ src: "x" }],
		start_url: "/dashboard",
	});

	it("keeps the shipped manifest for the platform brand", () => {
		expect(JSON.parse(renderManifest(base, PLATFORM_SHELL_BRAND))).toEqual({
			name: "CareerOS",
			short_name: "CareerOS",
			theme_color: "#F8F7F3",
			icons: [{ src: "x" }],
			start_url: "/dashboard",
		});
	});

	it("uses the organization's name, short name, theme colour and logo", () => {
		const manifest = JSON.parse(
			renderManifest(base, shellBrandFromPublic(branding({ appName: "Acme Careers Network" }))),
		);
		expect(manifest.name).toBe("Acme Careers Network");
		expect(manifest.short_name).toBe("Acme Careers");
		expect(manifest.theme_color).toBe("#1a56db");
		expect(manifest.icons).toEqual([
			{ src: `/api/branding-assets/org_acme/${FILE}`, sizes: "any", type: "image/png", purpose: "any" },
		]);
		expect(manifest.start_url).toBe("/dashboard");
	});

	it("is valid JSON for a hostile name", () => {
		const manifest = JSON.parse(renderManifest(base, shellBrandFromPublic(branding({ appName: ATTACK.slice(0, 60) }))));
		expect(manifest.name).toBe(ATTACK.slice(0, 60));
	});
});
