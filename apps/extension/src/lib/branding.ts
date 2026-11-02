// CAREEROS (P5-T01): what the popup learns about an organization from `GET <origin>/api/openapi/branding/host`
// (P2-T07). Everything the server sends is data: it is checked here, text is shown through React (escaped), and the
// logo is used only when it is on the same origin the user entered, over https (http only for a development host).
import { isHexColor } from "@reactive-resume/utils/brand";
import { isDevHttpHost } from "./address";

export const BRANDING_PATH = "/api/openapi/branding/host";

const MAX_NAME = 60;
const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 8000;

/** The fields of the CareerOS answer; each is a string or null. A server that lacks one is not a CareerOS server. */
const FIELDS = [
	"organizationId",
	"slug",
	"appName",
	"logoUrl",
	"faviconUrl",
	"primaryColor",
	"secondaryColor",
	"font",
	"supportUrl",
	"termsUrl",
	"privacyUrl",
] as const;

export type OrgBranding = {
	orgName: string;
	/** An absolute address on the entered origin, or null. */
	logoUrl: string | null;
	/** `#rrggbb`, or null. */
	primaryColor: string | null;
};

export type BrandingError =
	/** The server did not answer in time or at all. */
	| "unreachable"
	/** It answered, but not with the CareerOS shape. */
	| "not_careeros"
	/** A CareerOS server, but the address belongs to no organization (the platform default). */
	| "no_organization";

export type BrandingResult = { ok: true; branding: OrgBranding } | { ok: false; reason: BrandingError };

// eslint-disable-next-line no-control-regex -- control characters never belong in a name shown in the header.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** A logo address that is on `origin` over https (or the origin's own http in a development build), else null. */
export function sameOriginLogo(value: unknown, origin: string, devHttpHosts: readonly string[]): string | null {
	if (typeof value !== "string" || value === "" || value.length > 2048) return null;
	try {
		const base = new URL(origin);
		const url = new URL(value, base);
		if (url.origin !== base.origin || url.username !== "" || url.password !== "") return null;
		if (url.protocol === "https:") return url.toString();
		return url.protocol === "http:" && isDevHttpHost(url.hostname, devHttpHosts) ? url.toString() : null;
	} catch {
		return null;
	}
}

/** Checks a parsed answer. The wrong shape is refused; a bad logo or colour is dropped, not trusted. */
export function parseHostBranding(body: unknown, origin: string, devHttpHosts: readonly string[] = []): BrandingResult {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, reason: "not_careeros" };
	const record = body as Record<string, unknown>;
	for (const field of FIELDS) {
		const value = record[field];
		if (value !== null && typeof value !== "string") return { ok: false, reason: "not_careeros" };
	}

	const appName = typeof record.appName === "string" ? record.appName.replaceAll(CONTROL_CHARACTERS, "").trim() : "";
	// The platform address answers with every field null: it names no organization.
	if (record.organizationId === null || appName === "") return { ok: false, reason: "no_organization" };

	return {
		ok: true,
		branding: {
			orgName: appName.slice(0, MAX_NAME),
			logoUrl: sameOriginLogo(record.logoUrl, origin, devHttpHosts),
			primaryColor: isHexColor(record.primaryColor) ? record.primaryColor.toLowerCase() : null,
		},
	};
}

/** Asks `origin` for its public branding. No cookies, no redirects, a small body, a short wait. */
export async function fetchHostBranding(
	origin: string,
	devHttpHosts: readonly string[] = [],
	fetchImpl: typeof fetch = fetch,
): Promise<BrandingResult> {
	let response: Response;
	try {
		response = await fetchImpl(`${origin}${BRANDING_PATH}`, {
			method: "GET",
			headers: { accept: "application/json" },
			credentials: "omit",
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch {
		return { ok: false, reason: "unreachable" };
	}
	if (!response.ok) return { ok: false, reason: "not_careeros" };
	try {
		const text = await response.text();
		if (text.length > MAX_BODY_BYTES) return { ok: false, reason: "not_careeros" };
		return parseHostBranding(JSON.parse(text) as unknown, origin, devHttpHosts);
	} catch {
		return { ok: false, reason: "not_careeros" };
	}
}
