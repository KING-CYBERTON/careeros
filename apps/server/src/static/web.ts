import type { HostContext } from "@careeros/tenancy";
import type { BrandInfo } from "@reactive-resume/utils/brand";
import type { Locale } from "@reactive-resume/utils/locale";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { env } from "@reactive-resume/env/server";
import { jsonLdScript, socialMetaTags } from "@reactive-resume/pdf/web-page-document";
import { templateSchema } from "@reactive-resume/schema/templates";
import { isAppSectionPath, RESERVED_SEGMENTS } from "@reactive-resume/utils/app-paths";
import { PLATFORM_DEFAULT_APP_NAME } from "@reactive-resume/utils/brand";
import {
	defaultLocale,
	getLocaleAlternates,
	isLocale,
	localizedUrl,
	supportedLocales,
} from "@reactive-resume/utils/locale";
import { escapeHtml } from "@reactive-resume/utils/string";
// CAREEROS (P2-T02): organization branding injected into the shell at serve time
import {
	applyBrand,
	loadShellBrand,
	PLATFORM_SHELL_BRAND,
	renderManifest,
	shellCacheTags,
	varyOn,
	type BrandingLoader,
	type ShellBrand,
} from "./brand-shell";

function resolveWebDistPath() {
	const candidates = [
		// Source layout: apps/server/src/static/web.ts -> apps/web/dist
		fileURLToPath(new URL("../../../web/dist", import.meta.url)),
		// Bundled layout: apps/server/dist/index.mjs -> apps/web/dist
		fileURLToPath(new URL("../../web/dist", import.meta.url)),
	];
	const [fallback] = candidates;
	if (!fallback) throw new Error("Could not resolve web dist path");

	return candidates.find((candidate) => existsSync(candidate)) ?? fallback;
}

const staticRoot = resolveWebDistPath();
// CAREEROS (P6-M02): the landing pages (static/landing.ts) read their files from the same web build.
export const webDistRoot = staticRoot;
const indexHtmlPath = `${staticRoot}/index.html`;
// The marketing pages prerendered per locale by the web build (apps/web/vite.config.ts), as <page>/<locale>.html, kept
// beside dist/ so they're never served at an address of their own.
const prerenderRoot = `${staticRoot}-prerender`;
/**
 * Marketing pages the SPA owns that search engines should index.
 *
 * Without an entry here the fallback below returns 404 for the path in production — the dev Vite
 * server serves the shell for anything, so this failure only ever shows up once deployed.
 */
// CAREEROS: /licenses added (P2-T08).
const indexableAppPaths = new Set(["/ats-checker", "/resume-templates", "/licenses"]);
// CAREEROS (P6-T01, G10): the legal pages are public app pages. They are drafts until the owner approves them, so they are
// served as the app shell without a 404 but marked noindex; move them into `indexableAppPaths` on approval (Q282).
export const legalAppPaths = new Set(["/terms", "/privacy", "/dpa"]);
const reservedPublicResumeSegments = new Set<string>(RESERVED_SEGMENTS);

function isAssetPath(pathname: string): boolean {
	return pathname.split("/").pop()?.includes(".") ?? false;
}

function getPathSegments(pathname: string) {
	return pathname.split("/").filter(Boolean);
}

export function isPublicResumePath(pathname: string): boolean {
	const segments = getPathSegments(pathname);
	const [firstSegment] = segments;

	return segments.length === 2 && firstSegment !== undefined && !reservedPublicResumeSegments.has(firstSegment);
}

// Single-segment addresses the app or the server answer themselves, so they can never be a username's page.
const reservedProfileSegments = new Set([...reservedPublicResumeSegments, "cards", "sitemaps", "index.html"]);

/** `/<username>`: an account's primary resume. */
export function isProfilePath(pathname: string): boolean {
	const segments = getPathSegments(pathname);
	const [segment] = segments;
	return segments.length === 1 && segment !== undefined && !reservedProfileSegments.has(segment);
}

/**
 * Scripts run only from the app's own files and the inline scripts of the page served, allowed by hash; `wasm-unsafe-eval`
 * lets the PDF engine (Forme, WebAssembly) start. Pictures, avatars and fonts can live on any https host (a resume's
 * picture URL, a sign-in provider's avatar) and the PDF engine fetches them, so images, fonts and connections stay open
 * to https. Recordings, previews and workers use blob: URLs. Cloudflare Web Analytics, when turned on for the zone, injects
 * its real-user metrics beacon from static.cloudflareinsights.com.
 */
export function contentSecurityPolicy(html = "") {
	const inlineScripts = html.matchAll(
		/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g,
	);
	const hashes = [...inlineScripts].map(
		([, body]) =>
			`'sha256-${createHash("sha256")
				.update(body ?? "")
				.digest("base64")}'`,
	);
	return [
		"default-src 'self'",
		["script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com", ...hashes].join(" "),
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https:",
		"font-src 'self' data: https:",
		"connect-src 'self' data: blob: https:",
		"media-src 'self' data: blob:",
		"worker-src 'self' blob:",
		"frame-src 'self' blob:",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		// Print and template previews show a PDF from a blob: URL, which Chromium's viewer loads as a plugin.
		"object-src blob:",
	].join("; ");
}

export const BASE_SECURITY_HEADERS = {
	"X-Frame-Options": "DENY",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Content-Security-Policy": contentSecurityPolicy(),
};

/**
 * Preload links for the stylesheet and fonts a page's <head> loads. Cloudflare sends them ahead of the page as 103 Early
 * Hints, so they download while the origin is still answering.
 */
function preloadLinks(html: string) {
	const end = html.indexOf("</head>");
	const head = end === -1 ? html : html.slice(0, end);
	return [...head.matchAll(/<link\b[^>]*>/g)].flatMap(([tag]) => {
		const href = tag.match(/\bhref="(\/assets\/[^"]+)"/)?.[1];
		// The preload must share the tag's CORS mode, or the browser downloads the file twice.
		const cors = /\scrossorigin\b/.test(tag) ? "; crossorigin" : "";
		if (href && /\brel="stylesheet"/.test(tag)) return [`<${href}>; rel=preload; as=style${cors}`];
		if (href && /\brel="preload"/.test(tag) && /\bas="font"/.test(tag))
			return [`<${href}>; rel=preload; as=font${cors}`];
		return [];
	});
}

/**
 * An HTML page whose policy allows exactly the inline scripts of its template. Hashes come from the template before
 * any resume-derived markup goes in, so text that slipped past escaping could never allow itself.
 */
function htmlResponse(
	html: string,
	headers: Record<string, string>,
	template = html,
	// CAREEROS (P2-T02): the shell's brand decides the cache tags; the platform brand keeps the single `html` tag.
	shell: ShellBrand = PLATFORM_SHELL_BRAND,
) {
	// CAREEROS: the upstream third-party search note and site verification were removed (P2-T08).
	const body = html;
	return new Response(body, {
		headers: {
			...headers,
			Link: [headers.Link, ...preloadLinks(template)].filter(Boolean).join(", "),
			// Pages name the current build's assets, so a release purges this tag from Cloudflare's cache
			// (.github/workflows/docker-publish.yml). CAREEROS: an organization host adds its own tag.
			"Cache-Tag": shellCacheTags(shell),
			"Content-Security-Policy": contentSecurityPolicy(template),
		},
	});
}

// CAREEROS: the product name comes from the platform default; P2-T02 puts the org brand in per request (`applyBrand`).
const APP_NAME = PLATFORM_DEFAULT_APP_NAME;
// The English copy, for a build without prerendered pages; a prerendered page carries its own locale's title and
// description, and the social cards reuse them.
const ROOT_TITLE = `Your career workspace | ${APP_NAME}`;
const ROOT_DESCRIPTION = "Your career workspace. Sign in or create an account.";
const ATS_CHECKER_TITLE = `Free ATS resume checker | ${APP_NAME}`;
const ATS_CHECKER_DESCRIPTION =
	"Check whether software can read your resume PDF. Runs entirely in your browser, so your file is never uploaded.";
const TEMPLATES_TITLE = `Free resume templates with PDF examples | ${APP_NAME}`;
const TEMPLATES_DESCRIPTION =
	"Browse free resume templates, compare one-column and two-column layouts, and download sample PDFs. Customize your resume and export to PDF or Word.";

type StructuredData = Record<string, unknown>;

/** The organization behind the site, referenced by id from every page's structured data. */
function organization(origin: string, brand: BrandInfo): StructuredData {
	return {
		"@type": "Organization",
		"@id": `${origin}/#organization`,
		name: brand.appName,
		url: `${origin}/`,
		// CAREEROS: an organization's own logo; its size is not known, so the platform's 512 px size stays off it.
		logo: brand.logoUrl
			? { "@type": "ImageObject", url: `${origin}${brand.logoUrl}` }
			: { "@type": "ImageObject", url: `${origin}/pwa-512x512.png`, width: 512, height: 512 },
	};
}

function homepageStructuredData(origin: string, brand: BrandInfo): StructuredData {
	const rootUrl = `${origin}/`;
	return {
		"@context": "https://schema.org",
		"@graph": [
			organization(origin, brand),
			{
				"@type": "WebSite",
				"@id": `${origin}/#website`,
				name: brand.appName,
				url: rootUrl,
				publisher: { "@id": `${origin}/#organization` },
			},
		],
	};
}

function atsCheckerStructuredData(origin: string, brand: BrandInfo): StructuredData {
	return {
		"@context": "https://schema.org",
		"@graph": [
			organization(origin, brand),
			{
				"@type": "WebApplication",
				name: "ATS Checker",
				url: `${origin}/ats-checker`,
				description: ATS_CHECKER_DESCRIPTION,
				applicationCategory: "BusinessApplication",
				operatingSystem: "Web",
				isAccessibleForFree: true,
				offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
				isPartOf: { "@type": "WebSite", "@id": `${origin}/#website`, name: brand.appName, url: `${origin}/` },
				provider: { "@id": `${origin}/#organization` },
			},
		],
	};
}

type PageSeoOptions = {
	/** The page's plain address: the canonical for the default locale, and the base of its hreflang alternates. */
	canonicalUrl: string;
	locale: Locale;
	/** A `?locale=` request is canonical for its own language. */
	requested: boolean;
	/** Already HTML-escaped, as the page's own <title> and description are. */
	title: string;
	description: string;
	imageUrl: string;
	structuredData: StructuredData;
	/** CAREEROS (P2-T02): the product name for `og:site_name` (escaped by `socialMetaTags`). */
	siteName: string;
};

function createPageSeoMarkup(options: PageSeoOptions) {
	const pageUrl = options.requested ? localizedUrl(options.canonicalUrl, options.locale) : options.canonicalUrl;
	const alternates = getLocaleAlternates(options.canonicalUrl)
		.map(({ hreflang, href }) => `<link rel="alternate" hreflang="${hreflang}" href="${escapeHtml(href)}">`)
		.join("");

	const url = escapeHtml(pageUrl);

	return `
		<link rel="canonical" href="${url}">
		${alternates}
		<meta property="og:locale" content="${options.locale.replace("-", "_")}">
		${socialMetaTags({ type: "website", title: options.title, description: options.description, url, image: options.imageUrl, siteName: options.siteName })}
		${jsonLdScript(options.structuredData)}
	`;
}

/** The title and description a page was built with, still HTML-escaped. */
function readPageMeta(html: string, fallback: { title: string; description: string }) {
	return {
		title: html.match(/<title>([^<]*)<\/title>/)?.[1] ?? fallback.title,
		description: html.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1] ?? fallback.description,
	};
}

const mediaFile = /\.(?:avif|gif|ico|jpe?g|mp3|png|svg|ttf|webp|woff2?)$/i;

export const serveWebDistStatic = env.CLOUDFLARE
	? undefined
	: serveStatic({
			root: staticRoot,
			// The Docker build writes brotli copies beside the text files and WASM (tooling/docker/precompress.mjs).
			precompressed: true,
			onFound: (_path, context) => {
				// Vite fingerprints everything under /assets, so a file there never changes.
				if (context.req.path.startsWith("/assets/")) {
					context.header("Cache-Control", "public, max-age=31536000, immutable");
				} else if (context.req.path.startsWith("/site/") && context.req.query("v")) {
					// CAREEROS (P6-M02): the marketing pages ask for their stylesheets and scripts with the build's
					// revision in the address (static/landing.ts), so each address names one version for good.
					context.header("Cache-Control", "public, max-age=31536000, immutable");
					context.header("Cache-Tag", "public");
				} else {
					// Other files keep their names when their content changes, so a release purges them from Cloudflare's
					// cache by this tag. Browsers keep pictures, fonts and sounds for 30 days, the shortest lifetime Lighthouse
					// doesn't count as waste; one replaced under the same name reaches every visitor within that month.
					context.header("Cache-Tag", "public");
					if (mediaFile.test(context.req.path)) context.header("Cache-Control", "public, max-age=2592000");
				}
				// `/index.html` is the app shell too; it must not be frameable either.
				if (context.req.path.endsWith(".html"))
					for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) context.header(name, value);
			},
		});

function getFallbackResponseHeaders(pathname: string) {
	if (pathname === "/" || indexableAppPaths.has(pathname)) {
		return { "Content-Type": "text/html; charset=UTF-8", ...BASE_SECURITY_HEADERS };
	}
	if (isAppSectionPath(pathname) || legalAppPaths.has(pathname)) {
		// CAREEROS (P6-T01): the draft legal pages share the app sections' headers (shell, noindex).
		return {
			"Content-Type": "text/html; charset=UTF-8",
			"X-Robots-Tag": "noindex, follow",
			...BASE_SECURITY_HEADERS,
		};
	}

	return null;
}

/**
 * A prerendered page's language: a `?locale=` address first (its hreflang alternates), then the visitor's saved
 * choice, in the order the app reads them (apps/web/src/libs/locale.ts).
 */
function getPageLocale(request: Request) {
	const requested = new URL(request.url).searchParams.get("locale");
	if (isLocale(requested))
		return { locale: supportedLocales.includes(requested) ? requested : defaultLocale, requested: true };

	const saved = request.headers.get("cookie")?.match(/(?:^|;\s*)locale=([^;]*)/)?.[1] ?? "";
	return { locale: isLocale(saved) && supportedLocales.includes(saved) ? saved : defaultLocale, requested: false };
}

/** Swaps the page's <title> and description. Function replacers keep `$&`, `$'` etc. in user text literal. */
const withMeta = (html: string, meta: { title: string; description: string }) =>
	html
		.replace(/<title>[^<]*<\/title>/, () => `<title>${meta.title}</title>`)
		.replace(/<meta\s+name="description"[^>]*>/, () => `<meta name="description" content="${meta.description}">`);

/** The indexable pages the web build prerenders, by path. */
const prerenderedPages: Record<
	string,
	{
		name: string;
		meta: { title: string; description: string };
		image: string;
		structuredData: (origin: string, brand: BrandInfo) => StructuredData;
	}
> = {
	"/": {
		name: "home",
		meta: { title: ROOT_TITLE, description: ROOT_DESCRIPTION },
		image: "/opengraph/banner.jpg",
		structuredData: homepageStructuredData,
	},
	"/ats-checker": {
		name: "ats-checker",
		meta: { title: ATS_CHECKER_TITLE, description: ATS_CHECKER_DESCRIPTION },
		image: "/opengraph/ats-checker.png",
		structuredData: atsCheckerStructuredData,
	},
	"/resume-templates": {
		name: "resume-templates",
		meta: { title: TEMPLATES_TITLE, description: TEMPLATES_DESCRIPTION },
		image: "/opengraph/banner.jpg",
		structuredData: (origin) => ({
			"@context": "https://schema.org",
			"@type": "CollectionPage",
			name: "Free resume templates",
			url: `${origin}/resume-templates`,
			description: TEMPLATES_DESCRIPTION,
			mainEntity: {
				"@type": "ItemList",
				itemListElement: templateSchema.options.map((template, index) => ({
					"@type": "ListItem",
					position: index + 1,
					name: template.charAt(0).toUpperCase() + template.slice(1),
					url: `${origin}/resume-templates#${template}`,
				})),
			},
		}),
	},
};

export type ReadWebFile = (path: string) => Promise<string>;

const defaultReadFile: ReadWebFile = (path) => fs.readFile(path, "utf-8");

/** CAREEROS (P2-T02): the response headers every branded page carries, whatever its content. */
function brandedHeaders(headers: Record<string, string>, shell: ShellBrand) {
	return {
		...headers,
		// The page differs per host: a shared cache must never serve one organization's shell to another.
		Vary: varyOn(headers.Vary),
		// A shell built from a failed branding lookup shows the platform default; no cache may keep it.
		...(shell.degraded ? { "Cache-Control": "no-store" } : {}),
	};
}

/**
 * CAREEROS (P2-T03, P2-T02): the app shell with status 404 and no indexing, for a host that has the shape of an
 * organization host but names no organization. It carries the neutral platform brand and `window.__ORG_NOT_FOUND__`,
 * which the SPA turns into the "This address isn't set up yet" page.
 */
export async function handleUnknownOrgHost(readFile: ReadWebFile = defaultReadFile) {
	const shell = (await readFile(indexHtmlPath))
		.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml("This address isn't set up yet")}</title>`)
		.replace(/<meta\s+name="description"[^>]*>/, () => "");
	const html = applyBrand(shell, PLATFORM_SHELL_BRAND, { extraScript: "window.__ORG_NOT_FOUND__=true;" });
	const response = htmlResponse(html, {
		"Content-Type": "text/html; charset=UTF-8",
		"X-Robots-Tag": "noindex, nofollow",
		"Cache-Control": "no-store",
		Vary: "Host",
		...BASE_SECURITY_HEADERS,
	});
	return new Response(response.body, { status: 404, headers: response.headers });
}

/**
 * CAREEROS (P2-T02): `/manifest.webmanifest` for the request's host, with the organization's name, theme colour and
 * icon. Built from the shipped manifest at serve time; cached per host like the shell.
 */
export async function handleWebManifest(
	host: HostContext = { kind: "platform" },
	readFile: ReadWebFile = defaultReadFile,
	load?: BrandingLoader,
) {
	const shell = await loadShellBrand(host, load);
	// A build without the shipped manifest has nothing to brand.
	const base = await readFile(`${staticRoot}/manifest.webmanifest`).catch(() => null);
	if (base === null) return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
	return new Response(renderManifest(base, shell), {
		headers: brandedHeaders(
			{
				"Content-Type": "application/manifest+json; charset=UTF-8",
				"Cache-Control": shell.degraded ? "no-store" : "public, max-age=300",
				"Cache-Tag": shellCacheTags(shell, "public"),
				"X-Content-Type-Options": "nosniff",
			},
			shell,
		),
	});
}

export async function handleWebApp(
	request: Request,
	readFile: ReadWebFile = defaultReadFile,
	// CAREEROS (P2-T02): the host the middleware resolved; the platform host when none is given.
	host: HostContext = { kind: "platform" },
	loadBranding?: BrandingLoader,
) {
	const requestedPath = new URL(request.url).pathname;
	const pathname = requestedPath === "/index.html" ? "/" : requestedPath;

	// CAREEROS (P3-T07): the Super Admin console exists on the platform host only. On an organization host, a custom
	// domain or any other host its pages answer 404, decided here from the resolved host, never from the request.
	if (host.kind !== "platform" && (pathname === "/admin" || pathname.startsWith("/admin/")))
		return new Response("Not Found", {
			status: 404,
			headers: { "Content-Type": "text/plain; charset=UTF-8", "X-Robots-Tag": "noindex, nofollow" },
		});

	if (!isAppSectionPath(pathname) && isAssetPath(pathname)) {
		return new Response("Not Found", { status: 404 });
	}

	const baseHeaders = getFallbackResponseHeaders(pathname);
	if (!baseHeaders)
		return new Response("Not Found", {
			status: 404,
			headers: { "Content-Type": "text/plain; charset=UTF-8", "X-Robots-Tag": "noindex, nofollow" },
		});

	const shell = await loadShellBrand(host, loadBranding);
	const headers = brandedHeaders(baseHeaders, shell);

	// Hono drops HEAD bodies itself; returning early skips reading the shell and a public resume's DB lookup.
	if (request.method === "HEAD") return new Response(null, { status: 200, headers });

	const rawHtml = await readFile(indexHtmlPath);

	const prerendered = prerenderedPages[pathname];
	if (prerendered) {
		const { locale, requested } = getPageLocale(request);
		// CAREEROS (P2-T02): an organization host is its own site; its address is the canonical one.
		const siteOrigin = host.kind === "org" ? host.origin : new URL(env.APP_URL).origin;
		// Without a prerendered page (a build that skipped it), the app shell titled for the page renders it in the browser.
		const raw = await readFile(`${prerenderRoot}/${prerendered.name}/${locale}.html`).catch(() =>
			withMeta(rawHtml, prerendered.meta),
		);
		// Branded here, at serve time: the prerendered files hold the platform name and are shared by every host.
		const page = applyBrand(raw, shell);
		const markup = createPageSeoMarkup({
			canonicalUrl: new URL(pathname, host.kind === "org" ? host.origin : env.APP_URL).toString(),
			locale,
			requested,
			...readPageMeta(page, prerendered.meta),
			imageUrl: `${siteOrigin}${prerendered.image}`,
			structuredData: prerendered.structuredData(siteOrigin, shell.brand),
			siteName: shell.brand.appName,
		});

		// The saved locale changes what this address shows, so caches have to key on the cookie.
		return htmlResponse(
			page.replace("</head>", () => `${markup}</head>`),
			{ ...headers, Vary: varyOn("Cookie", "Host") },
			page,
			shell,
		);
	}

	const html = applyBrand(rawHtml, shell);
	return htmlResponse(html, headers, html, shell);
}
