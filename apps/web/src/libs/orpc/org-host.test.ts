import { describe, expect, it, vi } from "vite-plus/test";
import { handleOrgHostError, ORG_ACCESS_PATH } from "./org-host";

const notMember = { code: "FORBIDDEN", data: { code: "ORG_HOST_NOT_MEMBER" } };

describe("handleOrgHostError", () => {
	it("opens the join or switch page for a user who is not a member of this address's organization", () => {
		const assign = vi.fn();
		handleOrgHostError(notMember, { pathname: "/dashboard/resumes", search: "", assign });
		expect(assign).toHaveBeenCalledWith(ORG_ACCESS_PATH);
	});

	it("does not loop on the page itself", () => {
		const assign = vi.fn();
		handleOrgHostError(notMember, { pathname: ORG_ACCESS_PATH, search: "", assign });
		expect(assign).not.toHaveBeenCalled();
	});

	it("leaves every other error alone", () => {
		const assign = vi.fn();
		handleOrgHostError(
			{ code: "FORBIDDEN", message: "No active organization" },
			{ pathname: "/dashboard", search: "", assign },
		);
		handleOrgHostError(new Error("network"), { pathname: "/dashboard", search: "", assign });
		expect(assign).not.toHaveBeenCalled();
	});

	// CAREEROS (P2-T03a): an invitee is not a member yet, and the invitation is how they become one.
	describe("on the way to an invitation", () => {
		const callback = (id: string) => `?callbackURL=${encodeURIComponent(`/auth/accept-invitation/${id}`)}`;

		it("stays on the accept-invitation page", () => {
			const assign = vi.fn();
			handleOrgHostError(notMember, { pathname: "/auth/accept-invitation/inv_123", search: "", assign });
			expect(assign).not.toHaveBeenCalled();
		});

		it("stays on sign-in and registration that return to the invitation", () => {
			const assign = vi.fn();
			handleOrgHostError(notMember, { pathname: "/auth/login", search: callback("inv_123"), assign });
			handleOrgHostError(notMember, { pathname: "/auth/register", search: callback("inv_123"), assign });
			expect(assign).not.toHaveBeenCalled();
		});

		it("still redirects on sign-in with no callback or a callback elsewhere", () => {
			const assign = vi.fn();
			handleOrgHostError(notMember, { pathname: "/auth/login", search: "", assign });
			expect(assign).toHaveBeenCalledTimes(1);
			handleOrgHostError(notMember, { pathname: "/auth/login", search: "?callbackURL=%2Fdashboard", assign });
			expect(assign).toHaveBeenCalledTimes(2);
			expect(assign).toHaveBeenCalledWith(ORG_ACCESS_PATH);
		});

		it("still redirects on any other page", () => {
			const assign = vi.fn();
			handleOrgHostError(notMember, { pathname: "/dashboard/resumes", search: "", assign });
			expect(assign).toHaveBeenCalledWith(ORG_ACCESS_PATH);
		});
	});
});
