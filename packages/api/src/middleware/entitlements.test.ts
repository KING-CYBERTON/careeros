import { describe, expect, it } from "vite-plus/test";
import { EntitlementError } from "@careeros/billing";
import { ORPCError } from "@orpc/server";
import { isWriteRoute, SUSPENDED_ORG_ALLOWED_WRITES, toEntitlementORPCError } from "./entitlements";

describe("isWriteRoute", () => {
	it("treats GET as a read and everything else, including no method, as a write", () => {
		expect(isWriteRoute({ method: "GET" })).toBe(false);
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(isWriteRoute({ method })).toBe(true);
		expect(isWriteRoute({})).toBe(true);
		expect(isWriteRoute({ method: undefined })).toBe(true);
	});
});

describe("toEntitlementORPCError", () => {
	it("maps each refusal to FORBIDDEN (403) with its code, and the feature key when there is one", () => {
		const seat = toEntitlementORPCError(new EntitlementError("SEAT_LIMIT_REACHED", "full")) as ORPCError<
			string,
			unknown
		>;
		expect(seat).toBeInstanceOf(ORPCError);
		expect(seat).toMatchObject({
			code: "FORBIDDEN",
			status: 403,
			message: "full",
			data: { code: "SEAT_LIMIT_REACHED" },
		});
		const feature = toEntitlementORPCError(
			new EntitlementError("FEATURE_NOT_IN_PLAN", "no", "custom_domain"),
		) as ORPCError<string, unknown>;
		expect(feature.data).toEqual({ code: "FEATURE_NOT_IN_PLAN", feature: "custom_domain" });
	});

	it("passes every other error through unchanged", () => {
		const other = new Error("boom");
		expect(toEntitlementORPCError(other)).toBe(other);
	});
});

describe("SUSPENDED_ORG_ALLOWED_WRITES", () => {
	it("gives every entry a reason", () => {
		for (const [path, reason] of SUSPENDED_ORG_ALLOWED_WRITES) {
			expect(path.length).toBeGreaterThan(0);
			expect(reason.length).toBeGreaterThan(5);
		}
	});
});
