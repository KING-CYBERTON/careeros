// CAREEROS (P5-T01): the connection to one organization, kept in chrome.storage.local. T02 adds the sign-in token next
// to it; "Change organization" clears both.
import { isHexColor } from "@reactive-resume/utils/brand";
import { normalizeOrigin, permissionPattern } from "./address";
import { sameOriginLogo } from "./branding";

export type Connection = {
	origin: string;
	orgName: string;
	logoUrl: string | null;
	primaryColor: string | null;
};

const KEY = "connection";

/** A stored value is read as untrusted too: anything that fails the checks is treated as "not connected". */
export function readConnection(value: unknown, devHttpHosts: readonly string[]): Connection | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.origin !== "string" || typeof record.orgName !== "string" || record.orgName === "") return null;
	const address = normalizeOrigin(record.origin, devHttpHosts);
	if (!address.ok || address.origin !== record.origin) return null;
	return {
		origin: address.origin,
		orgName: record.orgName.slice(0, 60),
		logoUrl: sameOriginLogo(record.logoUrl, address.origin, devHttpHosts),
		primaryColor: isHexColor(record.primaryColor) ? record.primaryColor.toLowerCase() : null,
	};
}

export async function loadConnection(devHttpHosts: readonly string[]): Promise<Connection | null> {
	const stored = await chrome.storage.local.get(KEY);
	return readConnection(stored[KEY], devHttpHosts);
}

export async function saveConnection(connection: Connection): Promise<void> {
	await chrome.storage.local.set({ [KEY]: connection });
}

/** Forgets the organization and gives back its host permission. */
export async function clearConnection(origin: string): Promise<void> {
	// P5-T02: the sign-in belongs to the organization, so it goes with it.
	await chrome.storage.local.remove([KEY, "session", "deviceFlow"]);
	await releaseOrigin(origin);
}

/**
 * Asks the browser for host access to this one origin. Call it first in the click handler, before any await: the
 * browser only shows the prompt for a user gesture.
 */
export function requestOrigin(origin: string): Promise<boolean> {
	return chrome.permissions.request({ origins: [permissionPattern(origin)] });
}

/** Gives host access back; a failure is not an error the user can act on. */
export async function releaseOrigin(origin: string): Promise<void> {
	try {
		await chrome.permissions.remove({ origins: [permissionPattern(origin)] });
	} catch {
		// The permission was never granted, or is already gone.
	}
}

/**
 * Gives back every host permission the extension holds. Called when there is no stored connection: a popup that closed
 * after the browser granted access but before the connection was saved must not leave access behind.
 */
export async function releaseStrayOrigins(): Promise<void> {
	try {
		const { origins } = await chrome.permissions.getAll();
		if (origins && origins.length > 0) await chrome.permissions.remove({ origins });
	} catch {
		// Nothing to give back, or the browser refused; the next open tries again.
	}
}
