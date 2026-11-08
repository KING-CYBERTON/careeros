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
 * Better Auth endpoints (paths under /api/auth) an impersonated session may not call: the password, the email, two-factor
 * authentication, API keys, passkeys, linked accounts and deleting the account.
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
]);

/** Path prefixes with the same rule (every two-factor and passkey endpoint). */
export const IMPERSONATION_REFUSED_AUTH_PREFIXES: readonly string[] = ["/two-factor/", "/passkey/"];

export function isAuthPathRefusedWhileImpersonating(path: string): boolean {
	return (
		IMPERSONATION_REFUSED_AUTH_PATHS.has(path) ||
		IMPERSONATION_REFUSED_AUTH_PREFIXES.some((prefix) => path.startsWith(prefix))
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
