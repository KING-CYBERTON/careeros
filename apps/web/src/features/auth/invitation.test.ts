import { describe, expect, it } from "vite-plus/test";
import { acceptInvitationPath, invitationIdFromCallback } from "./invitation";

describe("invitation callback", () => {
	it("round-trips an invitation id", () => {
		expect(invitationIdFromCallback(acceptInvitationPath("abc-123"))).toBe("abc-123");
	});

	it("ignores other callbacks", () => {
		expect(invitationIdFromCallback(undefined)).toBeUndefined();
		expect(invitationIdFromCallback("/dashboard")).toBeUndefined();
		expect(invitationIdFromCallback("/auth/accept-invitation/")).toBeUndefined();
		expect(invitationIdFromCallback("//evil.test/auth/accept-invitation/abc")).toBeUndefined();
	});

	it("ignores a malformed escape", () => {
		expect(invitationIdFromCallback("/auth/accept-invitation/%E0%A4%A")).toBeUndefined();
	});
});
