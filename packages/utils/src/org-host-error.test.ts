import { describe, expect, it } from "vite-plus/test";
import { isOrgHostNotMemberError, ORG_HOST_NOT_MEMBER } from "./org-host-error";

describe("isOrgHostNotMemberError", () => {
	it("recognises the FORBIDDEN error with the host code", () => {
		expect(isOrgHostNotMemberError({ code: "FORBIDDEN", data: { code: ORG_HOST_NOT_MEMBER } })).toBe(true);
	});

	it("recognises the code on the error itself", () => {
		expect(isOrgHostNotMemberError({ code: ORG_HOST_NOT_MEMBER })).toBe(true);
	});

	it.each([
		null,
		undefined,
		"FORBIDDEN",
		{ code: "FORBIDDEN" },
		{ code: "FORBIDDEN", data: null },
		{ code: "FORBIDDEN", data: { code: "ORG_HOST_KEY_MISMATCH" } },
		{ code: "UNAUTHORIZED", data: { code: ORG_HOST_NOT_MEMBER } },
	])("ignores %j", (error) => {
		expect(isOrgHostNotMemberError(error)).toBe(false);
	});
});
