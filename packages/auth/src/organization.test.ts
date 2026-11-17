import { describe, expect, it } from "vite-plus/test";
import { defaultRoles } from "better-auth/plugins/organization/access";
import { auth } from "./config";
import { INVITATION_EXPIRES_IN_SECONDS, organizationOptions } from "./organization";

describe("organization plugin", () => {
	it("is registered after the admin plugin", () => {
		const ids = (auth.options.plugins ?? []).map((plugin) => plugin.id);
		expect(ids).toContain("organization");
		expect(ids.indexOf("organization")).toBeGreaterThan(ids.indexOf("admin"));
	});

	it("uses exactly the owner, admin and member roles, with the creator as owner", () => {
		expect(Object.keys(defaultRoles).toSorted()).toEqual(["admin", "member", "owner"]);
		expect(organizationOptions).not.toHaveProperty("roles");
		expect(organizationOptions.creatorRole).toBe("owner");
	});

	it("expires invitations after 7 days", () => {
		expect(INVITATION_EXPIRES_IN_SECONDS).toBe(7 * 24 * 60 * 60);
		expect(organizationOptions.invitationExpiresIn).toBe(INVITATION_EXPIRES_IN_SECONDS);
	});

	it("adds the cohortId and invitedBy member fields", () => {
		const fields = organizationOptions.schema.member.additionalFields;
		expect(Object.keys(fields).toSorted()).toEqual(["cohortId", "invitedBy"]);
	});
});
