import { describe, expect, it } from "vite-plus/test";
import { entitlementErrorCode, FEATURE_NOT_IN_PLAN, ORG_SUSPENDED, SEAT_LIMIT_REACHED } from "./entitlement-error";

describe("entitlementErrorCode", () => {
	it("reads the code from an oRPC error's data", () => {
		expect(entitlementErrorCode({ code: "FORBIDDEN", data: { code: SEAT_LIMIT_REACHED } })).toBe(SEAT_LIMIT_REACHED);
		expect(entitlementErrorCode({ code: "FORBIDDEN", data: { code: ORG_SUSPENDED } })).toBe(ORG_SUSPENDED);
		expect(entitlementErrorCode({ code: "FORBIDDEN", data: { code: FEATURE_NOT_IN_PLAN, feature: "x" } })).toBe(
			FEATURE_NOT_IN_PLAN,
		);
	});

	it("reads the code of a Better Auth client error", () => {
		expect(entitlementErrorCode({ code: SEAT_LIMIT_REACHED, message: "x", status: 403 })).toBe(SEAT_LIMIT_REACHED);
	});

	it.each([
		null,
		undefined,
		"ORG_SUSPENDED",
		5,
		{},
		{ code: "FORBIDDEN" },
		{ code: "FORBIDDEN", data: null },
		{ data: { code: "OTHER" } },
	])("ignores %j", (value) => {
		expect(entitlementErrorCode(value)).toBeUndefined();
	});
});
