// CAREEROS (P2-T05, phase plan D5): the browser side of the social and OIDC sign-in handoff. On an organization host
// the provider buttons call `begin` on that host instead of Better Auth's social sign-in, because the provider's single
// registered callback lives on the platform host. See apps/server/src/http/handoff.ts.

const BEGIN_PATH = "/api/careeros/handoff/begin";
const REDEEM_PATH = "/api/careeros/handoff/redeem";

type HostFlags = { appUrl?: string | undefined; aliasUrl?: string | undefined } | undefined;

function originOf(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		return new URL(value).origin;
	} catch {
		return undefined;
	}
}

/**
 * Whether this page is served from an address other than the platform's (`APP_URL`, or its alias): an organization's
 * own host. The server decides for real: `begin` answers 404 on the platform, and the caller then signs in directly.
 */
export function isOrganizationHost(flags: HostFlags, currentOrigin: string = window.location.origin): boolean {
	const platform = originOf(flags?.appUrl);
	if (!platform) return false;
	return currentOrigin !== platform && currentOrigin !== originOf(flags?.aliasUrl);
}

export type BeginResult =
	| { kind: "started"; url: string }
	/** The server says this address is not an organization host (or has no such provider): sign in directly. */
	| { kind: "unavailable" }
	| { kind: "error" };

/** Asks the organization host to start a handoff and returns the platform page to go to. */
export async function beginOrganizationHandoff(provider: string, returnTo: string | undefined): Promise<BeginResult> {
	try {
		const response = await fetch(BEGIN_PATH, {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider, ...(returnTo ? { returnTo } : {}) }),
		});
		if (response.status === 404) return { kind: "unavailable" };
		if (!response.ok) return { kind: "error" };
		const body: unknown = await response.json();
		if (body && typeof body === "object" && "url" in body && typeof body.url === "string")
			return { kind: "started", url: body.url };
		return { kind: "error" };
	} catch {
		return { kind: "error" };
	}
}

export type HandoffRequest = { provider: string; organizationName: string };

/** What the platform page needs for a request id, or `null` when it is unknown, expired or already used. */
export async function fetchHandoffRequest(requestId: string): Promise<HandoffRequest | null> {
	try {
		const response = await fetch(`/api/careeros/handoff/request/${encodeURIComponent(requestId)}`, {
			credentials: "same-origin",
		});
		if (!response.ok) return null;
		const body: unknown = await response.json();
		if (
			body &&
			typeof body === "object" &&
			"provider" in body &&
			typeof body.provider === "string" &&
			"organizationName" in body &&
			typeof body.organizationName === "string"
		)
			return { provider: body.provider, organizationName: body.organizationName };
		return null;
	} catch {
		return null;
	}
}

export type RedeemFragment = { token: string; request: string };

/** The token and request id in the `#token=...&request=...` fragment of the redeem page, or `null`. */
export function parseRedeemFragment(hash: string): RedeemFragment | null {
	const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
	const token = params.get("token");
	const request = params.get("request");
	return token && request ? { token, request } : null;
}

// React runs effects twice in development. The fragment is cleared from the address bar the first time it is read,
// so the parsed value is kept for the second pass instead of being read from an address that no longer holds it.
let capturedFragment: RedeemFragment | null | undefined;

/** Reads the fragment once and removes it from the address bar and the history entry. */
export function captureRedeemFragment(): RedeemFragment | null {
	if (capturedFragment !== undefined) return capturedFragment;
	capturedFragment = parseRedeemFragment(window.location.hash);
	window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
	return capturedFragment;
}

/** Test seam: forget what `captureRedeemFragment` kept. */
export function resetCapturedFragment(): void {
	capturedFragment = undefined;
}

/** Exchanges the one-time token for a session cookie on this host. Resolves with the return path, or `null`. */
export async function redeemOrganizationHandoff(fragment: RedeemFragment): Promise<string | null> {
	try {
		const response = await fetch(REDEEM_PATH, {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(fragment),
		});
		if (!response.ok) return null;
		const body: unknown = await response.json();
		if (body && typeof body === "object" && "returnTo" in body && typeof body.returnTo === "string")
			return body.returnTo;
		return null;
	} catch {
		return null;
	}
}
