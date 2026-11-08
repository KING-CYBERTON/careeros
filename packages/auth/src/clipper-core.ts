import { createHash, randomBytes } from "node:crypto";

// CAREEROS (P5-T02, phase plan G6): the pure rules of the Job Clipper's sign-in. No database, no Better Auth and no
// request here, so each rule is unit tested on its own. `clipper.ts` wires them into the auth instance.

/** The only client id the device flow accepts. A public client: it has no secret. */
export const CLIPPER_CLIENT_ID = "careeros-job-clipper";
/** The only scope a clipper device code carries. The procedure allow-list, not this word, limits the token. */
export const CLIPPER_SCOPE = "clipper";
export const CLIPPER_TOKEN_PREFIX = "cos_clip_";

export const DEVICE_CODE_LIFETIME = "10m";
export const DEVICE_POLL_INTERVAL = "5s";
/** The default alphabet of the plugin leaves out 0, O, 1 and I, so a code read aloud or typed is not mistaken. */
export const USER_CODE_LENGTH = 8;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A token lives 90 days. */
export const TOKEN_LIFETIME_MS = 90 * DAY_MS;
/** A use in the last 30 days of a token's life gives it 90 days again. */
export const TOKEN_SLIDE_WINDOW_MS = 30 * DAY_MS;
/** `last_used_at` is written at most this often, so a busy popup does not write on every call. */
export const LAST_USED_GRANULARITY_MS = 60 * 1000;

/** A new token: 256 random bits, URL safe, with a prefix that makes it recognizable to secret scanners. */
export function generateClipperToken(): string {
	return `${CLIPPER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Whether a bearer value has the shape of a clipper token. It does not say the token is valid. */
export function isClipperTokenFormat(value: string): boolean {
	return /^cos_clip_[A-Za-z0-9_-]{43}$/.test(value);
}

/** The only form in which a token is stored: hex SHA-256. The token has 256 bits, so no slow hash is needed. */
export function hashClipperToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/**
 * The expiry after a use at `now`: `null` when the token has expired, the same expiry while more than 30 days of life
 * remain, and `now + 90 days` once 30 days or fewer remain.
 */
export function nextClipperExpiry(now: number, expiresAt: number): number | null {
	if (expiresAt <= now) return null;
	return expiresAt - now <= TOKEN_SLIDE_WINDOW_MS ? now + TOKEN_LIFETIME_MS : expiresAt;
}

/** The part of a resolved host this rule needs; `HostContext` from @careeros/tenancy fits it. */
export type HostOrgRef = { kind: string; organizationId?: string | undefined };

/**
 * Whether a request host is one of the token's organization's hosts. The organization decides, not the host name, so
 * the organization's subdomain and its custom domains are the same place, and the platform host, another organization's
 * host and an unknown host are all refused.
 */
export function hostMatchesOrganization(host: HostOrgRef | undefined, organizationId: string): boolean {
	return host?.kind === "org" && host.organizationId === organizationId && organizationId.length > 0;
}

/** A short device label from a user agent, such as "Chrome on Windows". Never longer than 60 characters. */
export function deviceLabel(userAgent: string | null | undefined): string {
	const ua = userAgent ?? "";
	const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : null;
	const system = /Windows/.test(ua)
		? "Windows"
		: /CrOS/.test(ua)
			? "ChromeOS"
			: /Android/.test(ua)
				? "Android"
				: /Mac OS X|Macintosh/.test(ua)
					? "macOS"
					: /Linux|X11/.test(ua)
						? "Linux"
						: null;
	if (browser && system) return `${browser} on ${system}`;
	if (browser) return browser;
	return "Browser extension";
}

/** The user code as the plugin stores it: letters and digits only, upper case. */
export function normalizeUserCode(userCode: string): string {
	return userCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}
