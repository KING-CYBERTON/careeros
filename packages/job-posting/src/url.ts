// CAREEROS (P5-T03): posting addresses. `cleanPostingUrl` is what is saved (https, no fragment, no tracking parameters);
// `normalizePostingUrl` is what two addresses are compared by, so the same posting reached through two links is one.
import { MAX_URL_CHARS } from "./limits";

/** Parameters that say where a visitor came from, never which page it is. Matched on the lowercase name. */
const TRACKING_PARAMETERS = new Set([
	"gclid",
	"gbraid",
	"wbraid",
	"dclid",
	"fbclid",
	"msclkid",
	"yclid",
	"twclid",
	"ttclid",
	"li_fat_id",
	"mc_cid",
	"mc_eid",
	"igshid",
	"_hsenc",
	"_hsmi",
	"hsctatracking",
	"ref_src",
	"ref_url",
	"trk",
	"trkinfo",
	"trackingid",
	"refid",
	"lipi",
	"gh_src",
	"lever-source",
	"lever-origin",
	"source_ref",
	"vero_id",
	"vero_conv",
]);

/** Whether a query parameter is tracking: `utm_*`, `hsa_*`, `pk_*`, `mtm_*` or one of the known names. */
export function isTrackingParameter(name: string): boolean {
	const lower = name.toLowerCase();
	return /^(utm_|hsa_|pk_|mtm_|_ga)/.test(lower) || TRACKING_PARAMETERS.has(lower);
}

export type CleanUrlOptions = {
	/**
	 * http is refused unless this allows it: `true` for any host, or a function of the host name. The extension allows
	 * only the development hosts of a development build; the API allows http, because a member can save such a link by hand.
	 */
	allowHttp?: boolean | ((hostname: string) => boolean);
};

/**
 * The address to save, or `null`. https only (see `allowHttp`), no user name or password, no fragment, none of the known
 * tracking parameters, at most 2048 characters. Anything that does not parse is `null`.
 */
export function cleanPostingUrl(input: unknown, options: CleanUrlOptions = {}): string | null {
	if (typeof input !== "string") return null;
	const trimmed = input.trim();
	if (trimmed === "" || trimmed.length > MAX_URL_CHARS * 2) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.username || url.password) return null;
	if (url.protocol !== "https:") {
		if (url.protocol !== "http:") return null;
		const allow = options.allowHttp;
		const allowed = typeof allow === "function" ? allow(url.hostname.toLowerCase()) : allow === true;
		if (!allowed) return null;
	}
	url.hash = "";
	for (const name of new Set(url.searchParams.keys())) if (isTrackingParameter(name)) url.searchParams.delete(name);
	const out = url.toString();
	return out.length <= MAX_URL_CHARS ? out : null;
}

/**
 * The form two addresses are compared in: scheme ignored, host lowercase without a leading `www.`, no trailing slash on
 * the path, tracking parameters and fragment gone, remaining parameters in a fixed order. `null` when the input is not
 * an http(s) address.
 */
export function normalizePostingUrl(input: unknown): string | null {
	const cleaned = cleanPostingUrl(input, { allowHttp: true });
	if (!cleaned) return null;
	const url = new URL(cleaned);
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	const path = url.pathname.replace(/\/+$/, "") || "/";
	const parameters = [...url.searchParams.entries()].sort(([a, x], [b, y]) =>
		a === b ? x.localeCompare(y) : a.localeCompare(b),
	);
	const query = new URLSearchParams(parameters).toString();
	return `${host}${url.port ? `:${url.port}` : ""}${path}${query ? `?${query}` : ""}`;
}

/** The host part of a normalized address, for narrowing a database search before the exact comparison. */
export function postingHost(input: unknown): string | null {
	const normalized = normalizePostingUrl(input);
	return normalized ? (normalized.split(/[/?]/, 1)[0] ?? null) : null;
}
