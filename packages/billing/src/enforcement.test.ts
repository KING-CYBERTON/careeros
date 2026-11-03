import { describe, expect, it, vi } from "vite-plus/test";
import { assertFeature, assertSeatAvailable, assertWritable, EntitlementError, hasFreeSeat } from "./enforcement";

vi.mock("@reactive-resume/db/client", () => ({ db: {} }));

describe("hasFreeSeat", () => {
	it("is free below the limit and full at it", () => {
		expect(hasFreeSeat({ seatLimit: 5, seatsUsed: 4 })).toBe(true);
		expect(hasFreeSeat({ seatLimit: 5, seatsUsed: 5 })).toBe(false);
		expect(hasFreeSeat({ seatLimit: 5, seatsUsed: 7 })).toBe(false);
	});

	it("treats a null limit as unlimited", () => {
		expect(hasFreeSeat({ seatLimit: null, seatsUsed: 100_000 })).toBe(true);
	});

	it("lets an accepted invitation use the seat it already holds", () => {
		// 4 members and 1 pending invitation fill a limit of 5; accepting that invitation keeps the total at 5.
		expect(hasFreeSeat({ seatLimit: 5, seatsUsed: 5 }, true)).toBe(true);
		// Seats were lost after the invitation went out (limit lowered): the accept is refused.
		expect(hasFreeSeat({ seatLimit: 4, seatsUsed: 5 }, true)).toBe(false);
	});

	it("keeps a personal workspace to its single seat", () => {
		expect(hasFreeSeat({ seatLimit: 1, seatsUsed: 1 })).toBe(false);
	});
});

describe("assert helpers", () => {
	it("refuses a full organization with SEAT_LIMIT_REACHED", () => {
		expect(() => assertSeatAvailable({ seatLimit: 2, seatsUsed: 2 })).toThrow(EntitlementError);
		try {
			assertSeatAvailable({ seatLimit: 2, seatsUsed: 2 });
		} catch (error) {
			expect(error).toMatchObject({ code: "SEAT_LIMIT_REACHED" });
		}
		expect(() => assertSeatAvailable({ seatLimit: 3, seatsUsed: 2 })).not.toThrow();
	});

	it("refuses a suspended organization with ORG_SUSPENDED", () => {
		expect(() => assertWritable({ readOnly: true })).toThrow(expect.objectContaining({ code: "ORG_SUSPENDED" }));
		expect(() => assertWritable({ readOnly: false })).not.toThrow();
	});

	it("refuses a feature that is off or missing and names the key", () => {
		expect(() => assertFeature({ features: { custom_domain: true } }, "custom_domain")).not.toThrow();
		expect(() => assertFeature({ features: { custom_domain: false } }, "custom_domain")).toThrow(
			expect.objectContaining({ code: "FEATURE_NOT_IN_PLAN", feature: "custom_domain" }),
		);
		expect(() => assertFeature({ features: {} }, "custom_domain")).toThrow(
			expect.objectContaining({ code: "FEATURE_NOT_IN_PLAN" }),
		);
		expect(() => assertFeature({ features: {} }, "not_a_key")).toThrow(
			expect.objectContaining({ feature: "not_a_key" }),
		);
	});
});
