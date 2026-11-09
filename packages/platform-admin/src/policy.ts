// CAREEROS (P3-T07, phase plan D6): the rules of the platform console that are plain data, so the server, the auth
// configuration and the tests read one list. Nothing here touches a database.

/** How long a support (impersonation) session lasts, counted from its start. Never extended. */
export const IMPERSONATION_MINUTES = 60;
export const IMPERSONATION_MAX_MS = IMPERSONATION_MINUTES * 60 * 1000;
/** How long the one-time token that carries the session to the member's organization host lives. */
export const IMPERSONATION_TOKEN_SECONDS = 60;

/** Better Auth stores roles as a comma separated list; a platform admin has `admin` in it. */
export function hasPlatformAdminRole(role: string | null | undefined): boolean {
	return (role ?? "")
		.split(",")
		.map((value) => value.trim())
		.includes("admin");
}

/**
 * oRPC procedures an impersonated session may NOT call (requirement 3): the member's own account security, deleting the
 * account, API keys, billing actions and impersonating again. The key is the procedure's path. `protectedProcedure` and
 * `protectedProcedureWithoutOrg` refuse these with FORBIDDEN `IMPERSONATION_NOT_ALLOWED` while the session is a support
 * session. Add a path here when a new procedure changes how the member signs in, pays or holds a credential (the clipper
 * token procedures of P5-T02 belong here).
 */
export const IMPERSONATION_REFUSED_PROCEDURES: ReadonlyMap<string, string> = new Map([
	["auth.deleteAccount", "deleting the account"],
	["auth.createApiKey", "creating an API key"],
	["auth.apiKeys.delete", "deleting an API key"],
	// P5-T02: the member's Job Clipper credentials. A support session may neither approve a new one nor revoke one.
	["clipper.revokeToken", "revoking a Job Clipper token"],
	["billing.startTrial", "a billing action"],
	["billing.checkout", "a billing action"],
	["billing.changeSeats", "a billing action"],
	["billing.cancel", "a billing action"],
	["billing.portal", "a billing action"],
]);

/** Procedure paths under these prefixes are refused too (the platform console never runs inside a support session). */
export const IMPERSONATION_REFUSED_PREFIXES: readonly string[] = ["admin."];

export function isRefusedWhileImpersonating(path: string): boolean {
	return (
		IMPERSONATION_REFUSED_PROCEDURES.has(path) ||
		IMPERSONATION_REFUSED_PREFIXES.some((prefix) => path.startsWith(prefix))
	);
}

/**
 * Better Auth endpoints (paths under /api/auth) an impersonated session may not call: everything that changes how the
 * member signs in, and everything that creates, refreshes or hands out a credential that could outlive the 60 minutes
 * (P3-T09, Q421): the password, the email, two-factor authentication, API keys, passkeys, linked accounts, deleting the
 * account, OAuth clients and consent, access and refresh tokens, and ending the member's other sessions.
 * Compare with the normalized path (see normalizeAuthPath), never with the raw string.
 */
export const IMPERSONATION_REFUSED_AUTH_PATHS: ReadonlySet<string> = new Set([
	"/change-password",
	"/set-password",
	"/change-email",
	"/delete-user",
	"/delete-user/callback",
	"/link-social",
	"/unlink-account",
	"/api-key/create",
	"/api-key/update",
	"/api-key/delete",
	// P3-T09: tokens and sessions.
	"/get-access-token",
	"/refresh-token",
	"/revoke-session",
	"/revoke-sessions",
	"/revoke-other-sessions",
	// P5-T02: approving or denying a Job Clipper device sign-in would hand the admin a credential in the member's name.
	"/device/approve",
	"/device/deny",
	"/device/clipper/revoke",
	// P3-T09: the device-authorization endpoints of Better Auth that are not already switched off over HTTP.
	"/device/code",
	"/device/token",
]);

/**
 * Path prefixes with the same rule: every two-factor and passkey endpoint, and the whole OAuth provider (`/oauth2/`:
 * client create and register, consent, authorize, token, introspect, revoke; every one of them is a client, a consent or a
 * credential).
 */
export const IMPERSONATION_REFUSED_AUTH_PREFIXES: readonly string[] = ["/two-factor/", "/passkey/", "/oauth2/"];

/**
 * The form of a Better Auth path that policy compares: percent-decoded (repeatedly, so `%252f` cannot hide), lower case,
 * dot segments resolved, repeated slashes collapsed, no trailing slash, and without a leading `/api/auth`. A path that
 * does not decode is returned as it is, lower cased (it cannot match a route either).
 */
export function normalizeAuthPath(path: string): string {
	let value = path.split(/[?#]/, 1)[0] ?? "";
	for (let pass = 0; pass < 4; pass += 1) {
		try {
			const decoded = decodeURIComponent(value);
			if (decoded === value) break;
			value = decoded;
		} catch {
			break;
		}
	}
	const segments: string[] = [];
	for (const segment of value.replaceAll("\\", "/").toLowerCase().split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	if (segments[0] === "api" && segments[1] === "auth") segments.splice(0, 2);
	return `/${segments.join("/")}`;
}

export function isAuthPathRefusedWhileImpersonating(path: string): boolean {
	const normalized = normalizeAuthPath(path);
	return (
		IMPERSONATION_REFUSED_AUTH_PATHS.has(normalized) ||
		IMPERSONATION_REFUSED_AUTH_PREFIXES.some((prefix) => normalized.startsWith(prefix) || `${normalized}/` === prefix)
	);
}

/**
 * Every Better Auth admin-plugin endpoint (paths under /api/auth). They are switched off over HTTP: the console reaches
 * the platform only through the audited definer functions, granting the admin role is a command run by a person with
 * database owner access (`tooling/careeros/platform-admin.mjs`), and impersonation has its own audited, host-bound flow.
 * Left on, any admin session (on any host) could list every user, change roles or impersonate without a reason, a
 * limit or an audit row.
 */
export const DISABLED_ADMIN_AUTH_PATHS: readonly string[] = [
	"/admin/set-role",
	"/admin/get-user",
	"/admin/create-user",
	"/admin/update-user",
	"/admin/list-users",
	"/admin/list-user-sessions",
	"/admin/unban-user",
	"/admin/ban-user",
	"/admin/impersonate-user",
	"/admin/stop-impersonating",
	"/admin/revoke-user-session",
	"/admin/revoke-user-sessions",
	"/admin/remove-user",
	"/admin/set-user-password",
	"/admin/has-permission",
];
