import { describe, expect, it } from "vite-plus/test";
import {
	DISABLED_ADMIN_AUTH_PATHS,
	hasPlatformAdminRole,
	IMPERSONATION_MINUTES,
	IMPERSONATION_TOKEN_SECONDS,
	isAuthPathRefusedWhileImpersonating,
	isRefusedWhileImpersonating,
	normalizeAuthPath,
} from "./policy";

// CAREEROS (P3-T07): the plain-data rules of the console. No database.

describe("platform admin policy", () => {
	it("fixes the limits the requirement names", () => {
		expect(IMPERSONATION_MINUTES).toBe(60);
		expect(IMPERSONATION_TOKEN_SECONDS).toBe(60);
	});

	it("reads the admin role from a comma separated list, exactly", () => {
		expect(hasPlatformAdminRole("admin")).toBe(true);
		expect(hasPlatformAdminRole("user, admin")).toBe(true);
		expect(hasPlatformAdminRole("administrator")).toBe(false);
		expect(hasPlatformAdminRole("user")).toBe(false);
		expect(hasPlatformAdminRole(null)).toBe(false);
		expect(hasPlatformAdminRole(undefined)).toBe(false);
	});

	it.each([
		"auth.deleteAccount",
		"auth.createApiKey",
		"auth.apiKeys.delete",
		"billing.startTrial",
		"billing.checkout",
		"billing.changeSeats",
		"billing.cancel",
		"billing.portal",
		"clipper.revokeToken",
		"admin.orgs.list",
		"admin.impersonation.start",
	])("refuses %s in a support session", (path) => {
		expect(isRefusedWhileImpersonating(path)).toBe(true);
	});

	it.each([
		"resume.list",
		"applications.create",
		"billing.get",
		"announcements.dismiss",
		"impersonation.end",
		"administrators.list",
	])("allows %s in a support session", (path) => {
		expect(isRefusedWhileImpersonating(path)).toBe(false);
	});

	it.each([
		"/change-password",
		"/set-password",
		"/change-email",
		"/delete-user",
		"/link-social",
		"/api-key/create",
		"/two-factor/enable",
		"/two-factor/verify-totp",
		"/passkey/add-passkey",
		"/device/approve",
		"/device/deny",
		// P3-T09: credentials that outlive the session, and ending the member's other sessions.
		"/oauth2/create-client",
		"/oauth2/register",
		"/oauth2/consent",
		"/oauth2/authorize",
		"/oauth2/token",
		"/get-access-token",
		"/refresh-token",
		"/revoke-session",
		"/revoke-sessions",
		"/revoke-other-sessions",
		// Normalization: case, repeated and trailing slashes, encoding, dot segments, the /api/auth prefix.
		"/OAuth2/create-client",
		"/oauth2//register",
		"/oauth2/register/",
		"/oauth2%2Fcreate-client",
		"/oauth2/%63reate-client",
		"/oauth2/%252e%252e/oauth2/register",
		"/Revoke-Other-Sessions/",
		"//revoke-other-sessions",
		"/api/auth/oauth2/create-client",
		"/x/../oauth2/register",
		"/oauth2",
		"/Two-Factor/Enable",
	])("refuses the account endpoint %s in a support session", (path) => {
		expect(isAuthPathRefusedWhileImpersonating(path)).toBe(true);
	});

	it.each(["/get-session", "/sign-out", "/update-user", "/organization/list", "/device/clipper/token"])(
		"allows the endpoint %s",
		(path) => {
			expect(isAuthPathRefusedWhileImpersonating(path)).toBe(false);
		},
	);

	it("normalizes a path to one form", () => {
		expect(normalizeAuthPath("/OAuth2//Register/")).toBe("/oauth2/register");
		expect(normalizeAuthPath("/oauth2%2Fregister?x=1")).toBe("/oauth2/register");
		expect(normalizeAuthPath("/%E0%A4%A")).toBe("/%e0%a4%a");
		expect(normalizeAuthPath("")).toBe("/");
	});

	it("switches off every admin plugin endpoint over HTTP", () => {
		expect(DISABLED_ADMIN_AUTH_PATHS).toContain("/admin/impersonate-user");
		expect(DISABLED_ADMIN_AUTH_PATHS).toContain("/admin/set-role");
		expect(DISABLED_ADMIN_AUTH_PATHS.every((path) => path.startsWith("/admin/"))).toBe(true);
		expect(new Set(DISABLED_ADMIN_AUTH_PATHS).size).toBe(DISABLED_ADMIN_AUTH_PATHS.length);
	});
});
