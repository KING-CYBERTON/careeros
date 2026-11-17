// CAREEROS (P2-T02): turns an organization's public branding into the pieces the HTML shell carries: the title and
// icon tags, a `<style id="brand">` block that maps the colours and font onto the UI theme tokens, and the
// `window.__BRAND__` script the SPA reads at boot (`getBrand()`). Everything that reaches HTML, CSS or the script is
// validated again here and escaped for its position, although T01 validated it on the way in.
import type { HostContext } from "@careeros/tenancy";
import type { AccentTokens, BrandInfo } from "@reactive-resume/utils/brand";
import { BRANDING_FONTS } from "@reactive-resume/db/schema";
import { getWebFont } from "@reactive-resume/fonts";
import {
	accentTokens,
	DEFAULT_BRAND,
	isHexColor,
	PLATFORM_DEFAULT_APP_NAME,
	readableForeground,
} from "@reactive-resume/utils/brand";
import { escapeHtml } from "@reactive-resume/utils/string";

/** The public branding fields the shell reads (a subset of the API's `publicBrandingSchema`). */
export type PublicBrandingInput = {
	organizationId: string;
	appName: string | null;
	logoUrl: string | null;
	faviconUrl: string | null;
	primaryColor: string | null;
	secondaryColor: string | null;
	font: string | null;
	supportUrl: string | null;
	termsUrl: string | null;
	privacyUrl: string | null;
};

export type ShellBrand = {
	brand: BrandInfo;
	/** Set for an organization host; names the per-organization Cloudflare cache tag. */
	organizationId?: string | undefined;
	/** True when the branding could not be loaded and the platform default stands in. Such a page must not be cached. */
	degraded?: boolean | undefined;
};

export const PLATFORM_SHELL_BRAND: ShellBrand = { brand: DEFAULT_BRAND };

const MAX_APP_NAME = 60;
const ASSET_PATH =
	/^\/api\/branding-assets\/[A-Za-z0-9_-]{1,64}\/(?:logo|favicon)-[0-9a-f-]{36}\.(?:png|webp|svg|ico)$/;
const FONT_FILE = /^https:\/\/fonts\.gstatic\.com\/[A-Za-z0-9/_.-]+$/;
const FONT_WEIGHTS = ["400", "500", "600", "700"] as const;

const isBrandingFont = (value: unknown): value is (typeof BRANDING_FONTS)[number] =>
	typeof value === "string" && (BRANDING_FONTS as readonly string[]).includes(value);

function isHttpsLink(value: string | null): value is string {
	if (!value?.startsWith("https://") || value.length > 2048) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.username === "" && url.password === "";
	} catch {
		return false;
	}
}

/**
 * A branding asset's address as a path on the serving host. The API builds absolute URLs on `APP_URL`; the shell serves
 * them from the host that is asked, so the page works on custom domains and under the app's own CSP. Anything that is
 * not one of our asset paths is dropped.
 */
function assetPath(url: string | null): string | undefined {
	if (!url) return undefined;
	try {
		const { pathname } = new URL(url, "https://placeholder.invalid");
		return ASSET_PATH.test(pathname) ? pathname : undefined;
	} catch {
		return undefined;
	}
}

/** The brand for the shell from an organization's public branding. A null field uses the platform default. */
export function shellBrandFromPublic(branding: PublicBrandingInput): ShellBrand {
	const appName = branding.appName?.trim().slice(0, MAX_APP_NAME) || DEFAULT_BRAND.appName;
	const logoUrl = assetPath(branding.logoUrl);
	const faviconUrl = assetPath(branding.faviconUrl);
	const brand: BrandInfo = {
		appName,
		...(logoUrl && { logoUrl }),
		...(faviconUrl && { faviconUrl }),
		...(isHttpsLink(branding.supportUrl) && { supportUrl: branding.supportUrl }),
		...(isHttpsLink(branding.termsUrl) && { termsUrl: branding.termsUrl }),
		...(isHttpsLink(branding.privacyUrl) && { privacyUrl: branding.privacyUrl }),
		...(isHexColor(branding.primaryColor) && { primaryColor: branding.primaryColor.toLowerCase() }),
		...(isHexColor(branding.secondaryColor) && { secondaryColor: branding.secondaryColor.toLowerCase() }),
		...(isBrandingFont(branding.font) && { font: branding.font }),
	};
	return { brand, organizationId: branding.organizationId };
}

export type BrandingLoader = (organizationId: string) => Promise<PublicBrandingInput | null>;

// The API module reaches the database, so it loads on first use; hosts without organizations never pay for it.
const defaultLoader: BrandingLoader = async (organizationId) =>
	(await import("@reactive-resume/api/features/branding")).getCachedPublicBranding(organizationId);

/**
 * The brand for a request's host. Only an organization host the middleware resolved is branded, from its own id; every
 * other host gets the platform default. A failed lookup also gets the default, marked `degraded` so it is not cached.
 */
export async function loadShellBrand(host: HostContext, load: BrandingLoader = defaultLoader): Promise<ShellBrand> {
	if (host.kind !== "org") return PLATFORM_SHELL_BRAND;
	try {
		const branding = await load(host.organizationId);
		return branding ? shellBrandFromPublic(branding) : { ...PLATFORM_SHELL_BRAND, organizationId: host.organizationId };
	} catch (error) {
		console.error("[branding] Could not load the organization's branding; serving the platform default.", { error });
		return { ...PLATFORM_SHELL_BRAND, organizationId: host.organizationId, degraded: true };
	}
}

const scriptEscapes: Record<string, string> = {
	"<": "\\u003C",
	">": "\\u003E",
	"&": "\\u0026",
	"\u2028": "\\u2028",
	"\u2029": "\\u2029",
};

/** JSON for an inline `<script>`: no character in it can close the script or end a line in the source. */
export function serializeForInlineScript(value: unknown): string {
	return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => scriptEscapes[character] ?? character);
}

function fontFaces(font: string): string {
	const webFont = getWebFont(font);
	if (!webFont) return "";
	return FONT_WEIGHTS.flatMap((weight) => {
		const file = (webFont.files as Record<string, string | undefined>)[weight];
		if (!file || !FONT_FILE.test(file)) return [];
		return [
			`@font-face{font-family:"${font}";font-style:normal;font-weight:${weight};font-display:swap;src:url("${file}") format("truetype")}`,
		];
	}).join("");
}

const fontStack = (font: string) =>
	`"${font}","Figtree Variable",${getWebFont(font)?.category === "serif" ? "Georgia,serif" : "system-ui,sans-serif"}`;

const cssTokens = (tokens: AccentTokens) => [
	`--accent:${tokens.accent}`,
	`--accent-hover:${tokens.accentHover}`,
	`--on-accent:${tokens.onAccent}`,
	`--accent-soft:${tokens.accentSoft}`,
	`--accent-text:${tokens.accentText}`,
];

/**
 * CSS variables for the colours and font. They override the Desk & Paper tokens in `packages/ui/src/styles/globals.css`:
 * `--accent`, `--accent-hover`, `--on-accent`, `--accent-soft`, `--accent-text` (light and `.dark`) and `--font-ui`.
 * Secondary has no token in the theme yet, so it is exposed as `--brand-secondary` and `--brand-on-secondary` only.
 * Empty when the brand sets none of them.
 */
export function renderBrandCss(brand: BrandInfo): string {
	const root: string[] = [];
	let faces = "";
	let dark = "";
	const { primaryColor, secondaryColor, font } = brand;

	if (primaryColor && isHexColor(primaryColor)) {
		const { light, dark: night } = accentTokens(primaryColor);
		root.push(...cssTokens(light));
		dark = `:root.dark{${cssTokens(night).join(";")}}`;
	}
	if (secondaryColor && isHexColor(secondaryColor))
		root.push(`--brand-secondary:${secondaryColor}`, `--brand-on-secondary:${readableForeground(secondaryColor)}`);
	if (font && font !== "Figtree" && isBrandingFont(font)) {
		root.push(`--font-ui:${fontStack(font)}`);
		faces = fontFaces(font);
	}
	return root.length === 0 ? "" : `${faces}:root{${root.join(";")}}${dark}`;
}

/** The `<style id="brand">` block and the `window.__BRAND__` script. */
function renderBrandHead(shell: ShellBrand, extraScript = ""): string {
	const css = renderBrandCss(shell.brand);
	return `${css ? `<style id="brand">${css}</style>` : ""}<script>window.__BRAND__=${serializeForInlineScript(shell.brand)};${extraScript}</script>`;
}

/** Splits HTML around its `<script>` and `<style>` blocks and maps the text between them. */
const outsideCode = (html: string, map: (segment: string) => string) =>
	html
		.split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/i)
		.map((part, index) => (index % 2 === 1 ? part : map(part)))
		.join("");

const iconType = (path: string) => (path.endsWith(".ico") ? "image/x-icon" : path.endsWith(".png") ? "image/png" : "");

/** Swaps the document's icon links for the brand's favicon. Unchanged without one. */
export function replaceIconLinks(html: string, brand: BrandInfo): string {
	if (!brand.faviconUrl) return html;
	const href = escapeHtml(brand.faviconUrl);
	const type = iconType(brand.faviconUrl);
	const links = `<link rel="icon" href="${href}"${type ? ` type="${type}"` : ""}><link rel="apple-touch-icon" href="${href}">`;
	let placed = false;
	return html.replace(/<link\b[^>]*\brel="(?:icon|apple-touch-icon)"[^>]*>/g, () => {
		if (placed) return "";
		placed = true;
		return links;
	});
}

/**
 * Brands an HTML shell at serve time: the platform name in the text becomes the app name, the icons and the loader logo
 * follow the brand, and the style and script blocks go in before `</head>`. The platform brand passes through with its
 * script block only. Replacements use functions, so `$&` and the like in a name stay literal.
 */
export function applyBrand(html: string, shell: ShellBrand, options: { extraScript?: string } = {}): string {
	const { brand } = shell;
	let result = html;
	if (brand.appName !== PLATFORM_DEFAULT_APP_NAME) {
		const name = escapeHtml(brand.appName);
		result = outsideCode(result, (segment) => segment.replaceAll(PLATFORM_DEFAULT_APP_NAME, () => name));
	}
	result = replaceIconLinks(result, brand);
	if (brand.logoUrl) {
		const logo = escapeHtml(brand.logoUrl);
		result = result.replace(/src="\/icon\/(?:light|dark)\.svg"/g, () => `src="${logo}"`);
	}
	if (brand.primaryColor && isHexColor(brand.primaryColor)) {
		const color = brand.primaryColor;
		result = result.replace(
			/(<meta\b[^>]*name="theme-color"[^>]*content=")#f8f7f3("[^>]*prefers-color-scheme:\s*light)/i,
			(_match, before: string, after: string) => `${before}${color}${after}`,
		);
	}
	return result.replace("</head>", () => `${renderBrandHead(shell, options.extraScript)}</head>`);
}

/** Adds `Host` to a `Vary` header value, once. */
export function varyOn(existing: string | undefined, name = "Host"): string {
	const names = (existing ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return names.some((entry) => entry.toLowerCase() === name.toLowerCase() || entry === "*")
		? names.join(", ")
		: [...names, name].join(", ");
}

/** The Cloudflare cache tags of a shell page: `html` for the release purge, plus the organization's own tag. */
export function shellCacheTags(shell: ShellBrand, base = "html"): string {
	return shell.organizationId && /^[A-Za-z0-9_-]{1,64}$/.test(shell.organizationId)
		? `${base},org-${shell.organizationId}`
		: base;
}

type Manifest = Record<string, unknown> & { icons?: unknown };

/** The web app manifest for a host: name, short name, theme colour and icons from the brand; the rest as built. */
export function renderManifest(baseJson: string, shell: ShellBrand): string {
	const manifest = JSON.parse(baseJson) as Manifest;
	const { brand } = shell;
	const icon = brand.logoUrl ?? brand.faviconUrl;
	const next: Manifest = {
		...manifest,
		name: brand.appName,
		short_name: [...brand.appName].slice(0, 12).join("").trim() || brand.appName,
		...(brand.primaryColor && { theme_color: brand.primaryColor }),
		...(icon && {
			icons: [
				{
					src: icon,
					sizes: "any",
					type: icon.endsWith(".svg")
						? "image/svg+xml"
						: icon.endsWith(".webp")
							? "image/webp"
							: icon.endsWith(".ico")
								? "image/x-icon"
								: "image/png",
					purpose: "any",
				},
			],
		}),
	};
	return JSON.stringify(next);
}
