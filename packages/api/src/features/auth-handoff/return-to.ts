// CAREEROS (P2-T05): where the browser lands on the organization host after a handoff sign-in. The value comes from
// the client at `begin`, so it is validated there and stored; anything that is not a plain path on the organization's
// own origin becomes the dashboard.

export const DEFAULT_RETURN_TO = "/dashboard";
const MAX_RETURN_TO_LENGTH = 512;

// oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused here.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Whether `value` is unsafe as a redirect path, in its literal form (it is checked again once percent-decoded). */
function isUnsafePath(value: string): boolean {
	return value.includes("//") || value.includes("\\") || CONTROL_CHARACTERS.test(value);
}

/**
 * A relative path that is safe to redirect to on `targetOrigin`, or `/dashboard`. The path must start with exactly
 * one `/`, hold no `//`, `\`, control character or `@` ahead of its first `/`, be at most 512 characters, and resolve
 * against `targetOrigin` to that same origin. Percent-encoded spellings of the refused characters are refused too.
 */
export function sanitizeReturnTo(value: unknown, targetOrigin: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) return DEFAULT_RETURN_TO;
	if (!value.startsWith("/") || value.startsWith("//") || isUnsafePath(value)) return DEFAULT_RETURN_TO;
	// Starting with a single `/` already rules out a scheme or user-info (`@`) ahead of the first slash.

	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return DEFAULT_RETURN_TO;
	}
	if (!decoded.startsWith("/") || decoded.startsWith("//") || isUnsafePath(decoded)) return DEFAULT_RETURN_TO;

	try {
		const resolved = new URL(value, targetOrigin);
		if (resolved.origin !== new URL(targetOrigin).origin) return DEFAULT_RETURN_TO;
	} catch {
		return DEFAULT_RETURN_TO;
	}
	return value;
}
