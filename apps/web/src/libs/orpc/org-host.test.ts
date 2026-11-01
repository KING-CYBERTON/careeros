import { describe, expect, it, vi } from "vite-plus/test";
import { handleOrgHostError, ORG_ACCESS_PATH } from "./org-host";

const notMember = { code: "FORBIDDEN", data: { code: "ORG_HOST_NOT_MEMBER" } };

describe("handleOrgHostError", () => {
	it("opens the join or switch page for a user who is not a member of this address's organization", () => {
		const assign = vi.fn();
		handleOrgHostError(notMember, { pathname: "/dashboard/resumes", assign });
		expect(assign).toHaveBeenCalledWith(ORG_ACCESS_PATH);
	});

	it("does not loop on the page itself", () => {
		const assign = vi.fn();
		handleOrgHostError(notMember, { pathname: ORG_ACCESS_PATH, assign });
		expect(assign).not.toHaveBeenCalled();
	});

	it("leaves every other error alone", () => {
		const assign = vi.fn();
		handleOrgHostError({ code: "FORBIDDEN", message: "No active organization" }, { pathname: "/dashboard", assign });
		handleOrgHostError(new Error("network"), { pathname: "/dashboard", assign });
		expect(assign).not.toHaveBeenCalled();
	});
});
