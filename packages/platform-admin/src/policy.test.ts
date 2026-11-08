import { describe, expect, it } from "vite-plus/test";
import {
	DISABLED_ADMIN_AUTH_PATHS,
	hasPlatformAdminRole,
	IMPERSONATION_MINUTES,
	IMPERSONATION_TOKEN_SECONDS,
	isAuthPathRefusedWhileImpersonating,
	isRefusedWhileImpersonating,
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
	])("refuses the account endpoint %s in a support session", (path) => {
		expect(isAuthPathRefusedWhileImpersonating(path)).toBe(true);
	});

	it.each(["/get-session", "/sign-out", "/update-user", "/organization/list", "/device/clipper/token"])(
		"allows the endpoint %s",
		(path) => {
			expect(isAuthPathRefusedWhileImpersonating(path)).toBe(false);
		},
	);

	it("switches off every admin plugin endpoint over HTTP", () => {
		expect(DISABLED_ADMIN_AUTH_PATHS).toContain("/admin/impersonate-user");
		expect(DISABLED_ADMIN_AUTH_PATHS).toContain("/admin/set-role");
		expect(DISABLED_ADMIN_AUTH_PATHS.every((path) => path.startsWith("/admin/"))).toBe(true);
		expect(new Set(DISABLED_ADMIN_AUTH_PATHS).size).toBe(DISABLED_ADMIN_AUTH_PATHS.length);
	});
});
