// CAREEROS (P6-M02): the marketing pages. The files live in the web build under `site/` (apps/web/public/site);
// visitors reach them as `/` and `/organisations` on the platform host, never by folder or file name.
import type { ReadWebFile } from "./web";
import type { HostContext } from "@careeros/tenancy";
import fs from "node:fs/promises";
import { env } from "@reactive-resume/env/server";
import { BASE_SECURITY_HEADERS, webDistRoot } from "./web";

/** The address of each marketing page and the file it shows. */
export const LANDING_PAGES: Readonly<Record<string, string>> = {
	"/": "index.html",
	"/organisations": "organisations.html",
};

/** The marketing pages' addresses, for the sitemap. */
export const LANDING_PATHS = Object.keys(LANDING_PAGES);

/** The folder the pages' stylesheets, scripts and fonts are served from. */
export const LANDING_FOLDER = "/site";

const defaultReadFile: ReadWebFile = (path) => fs.readFile(path, "utf-8");

const escapeAttribute = (value: string) =>
	value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The tags that need this deployment's own address: the canonical link and the share card's address and picture. */
function addressTags(pathname: string) {
	const origin = env.APP_URL.replace(/\/+$/, "");
	const url = escapeAttribute(`${origin}${pathname === "/" ? "/" : pathname}`);
	const image = escapeAttribute(`${origin}/opengraph/banner.jpg`);
	return [
		`<link rel="canonical" href="${url}">`,
		`<meta property="og:url" content="${url}">`,
		`<meta property="og:site_name" content="CareerOS">`,
		`<meta property="og:image" content="${image}">`,
		`<meta name="twitter:image" content="${image}">`,
	].join("\n");
}

/**
 * Adds this build's revision to the address of each stylesheet and script in the site folder, so a browser can keep
 * those files for a year (web.ts sends them as immutable) and still fetch new ones after a release. Addresses that
 * already carry a version, as the careeros-landing workflow writes on staging, are left alone.
 */
function versionAssets(html: string) {
	const revision = env.APP_REVISION?.slice(0, 12);
	if (!revision) return html;
	return html.replaceAll(/((?:href|src)="\/site\/[^"?#]+\.(?:css|js))"/g, `$1?v=${encodeURIComponent(revision)}"`);
}

/**
 * The marketing page for `pathname`, or null when there is none to show: the address is not a marketing page, the host
 * is not the platform host (an organization's address never shows CareerOS marketing), or the file is missing from
 * this build. On null the caller carries on to the app, which answers as it did before these pages existed.
 */
export async function handleLandingPage(
	pathname: string,
	host: HostContext = { kind: "platform" },
	readFile: ReadWebFile = defaultReadFile,
): Promise<Response | null> {
	const file = LANDING_PAGES[pathname];
	if (!file || host.kind !== "platform") return null;

	// Read on every request: the careeros-landing workflow replaces these files in a running staging container.
	const html = await readFile(`${webDistRoot}${LANDING_FOLDER}/${file}`).catch(() => null);
	if (html === null) return null;

	return new Response(versionAssets(html).replace("</head>", `${addressTags(pathname)}\n</head>`), {
		headers: {
			"Content-Type": "text/html; charset=UTF-8",
			...BASE_SECURITY_HEADERS,
			// Always revalidated: the pages change without a release on staging, and they are small.
			"Cache-Control": "no-cache",
			"Cache-Tag": "html",
		},
	});
}

/**
 * Where a request for a page's file should go instead: `/site/index.html`, `/site/organisations.html` and the old
 * `/landing/…` links all move to the page's own address, so a file name never shows and no page has two addresses.
 * Null for anything else, including the folder's stylesheets, scripts and fonts.
 */
export function landingRedirect(pathname: string): string | null {
	const match = /^\/(?:site|landing)(?:\/([^/]*))?$/.exec(pathname);
	if (!match) return null;
	const file = match[1] ?? "";
	if (file === "" || file === "index.html") return "/";
	if (file === "organisations.html") return "/organisations";
	// Any other file under the retired /landing folder has nowhere to go but home.
	return pathname.startsWith("/landing") ? "/" : null;
}
