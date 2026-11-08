// CAREEROS (P5-T02): the clipper token and the organization origin it belongs to, kept in chrome.storage.local. The token
// is attached to a request only when the request goes to that exact origin AND the origin the extension is connected
// to (`authorizedRequest`); anything else is refused before a byte leaves. "Change organization" and sign-out clear it.
import type { DeviceFlow } from "./device-flow";
import { normalizeOrigin } from "./address";

export type Session = {
	/** The origin the token was issued for. */
	origin: string;
	token: string;
	userName: string;
};

const SESSION_KEY = "session";
const FLOW_KEY = "deviceFlow";

/** A stored value is untrusted: anything that fails the checks is "not signed in". */
export function readSession(value: unknown, devHttpHosts: readonly string[]): Session | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.origin !== "string" || typeof record.token !== "string" || record.token === "") return null;
	const address = normalizeOrigin(record.origin, devHttpHosts);
	if (!address.ok || address.origin !== record.origin) return null;
	return {
		origin: address.origin,
		token: record.token,
		userName: typeof record.userName === "string" ? record.userName.slice(0, 120) : "",
	};
}

export function readFlow(value: unknown, devHttpHosts: readonly string[]): DeviceFlow | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.origin !== "string" ||
		typeof record.deviceCode !== "string" ||
		typeof record.userCode !== "string" ||
		typeof record.interval !== "number" ||
		typeof record.expiresAt !== "number"
	)
		return null;
	const address = normalizeOrigin(record.origin, devHttpHosts);
	if (!address.ok || address.origin !== record.origin) return null;
	return {
		origin: address.origin,
		deviceCode: record.deviceCode,
		userCode: record.userCode,
		interval: record.interval,
		expiresAt: record.expiresAt,
	};
}

export async function loadSession(devHttpHosts: readonly string[]): Promise<Session | null> {
	const stored = await chrome.storage.local.get(SESSION_KEY);
	return readSession(stored[SESSION_KEY], devHttpHosts);
}

export async function saveSession(session: Session): Promise<void> {
	await chrome.storage.local.set({ [SESSION_KEY]: session });
}

export async function clearSession(): Promise<void> {
	await chrome.storage.local.remove(SESSION_KEY);
}

export async function loadFlow(devHttpHosts: readonly string[]): Promise<DeviceFlow | null> {
	const stored = await chrome.storage.local.get(FLOW_KEY);
	return readFlow(stored[FLOW_KEY], devHttpHosts);
}

export async function saveFlow(flow: DeviceFlow): Promise<void> {
	await chrome.storage.local.set({ [FLOW_KEY]: flow });
}

export async function clearFlow(): Promise<void> {
	await chrome.storage.local.remove(FLOW_KEY);
}

/**
 * The request, with the token attached, or `null` when it must not be sent: the token belongs to another origin than the
 * request's, or the extension is connected to a different organization than the token's. Redirects are an error and no
 * cookie is sent, so the token cannot be forwarded or mixed with a browser session.
 */
export function authorizedRequest(
	session: Session,
	connectedOrigin: string,
	url: string,
	init: RequestInit = {},
): { url: string; init: RequestInit } | null {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return null;
	}
	if (target.origin !== session.origin || session.origin !== connectedOrigin) return null;
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${session.token}`);
	return {
		url: target.toString(),
		init: { ...init, headers, credentials: "omit", redirect: "error", cache: "no-store" },
	};
}

export type ApiResult<T> =
	| { ok: true; data: T }
	| { ok: false; reason: "unauthorized" | "refused" | "unreachable" | "failed" };

/** Calls the connected organization's API with the token. A 401 means the token is gone: the caller clears it. */
export async function callApi<T>(
	session: Session,
	connectedOrigin: string,
	path: string,
	init: RequestInit = {},
	fetcher: typeof fetch = fetch,
): Promise<ApiResult<T>> {
	const request = authorizedRequest(session, connectedOrigin, `${session.origin}${path}`, init);
	if (!request) return { ok: false, reason: "refused" };
	let response: Response;
	try {
		response = await fetcher(request.url, request.init);
	} catch {
		return { ok: false, reason: "unreachable" };
	}
	if (response.status === 401) return { ok: false, reason: "unauthorized" };
	if (!response.ok) return { ok: false, reason: "failed" };
	return { ok: true, data: (await response.json().catch(() => null)) as T };
}
