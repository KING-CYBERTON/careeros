import { expect, it } from "vite-plus/test";
import { billingStateKind, daysUntil, ownerBannerKind, paymentConfirmed, planPrice, seatProblem } from "./lib";

// CAREEROS (P3-T06): the pure rules of the billing page.

const now = new Date("2026-11-09T00:00:00Z");
const day = (n: number) => new Date(now.getTime() + n * 86_400_000);
const snapshot = (over: Record<string, unknown> = {}, sub: Record<string, unknown> = {}) =>
	({
		planId: "starter",
		status: "active",
		subscription: {
			status: "active",
			provider: "fake",
			seats: 5,
			currentPeriodStart: day(-30),
			currentPeriodEnd: day(0),
			trialEndsAt: null,
			graceEndsAt: null,
			...sub,
		},
		...over,
	}) as never;

it("names the five states", () => {
	expect(billingStateKind(snapshot({ status: "trial" }))).toBe("trial");
	expect(billingStateKind(snapshot())).toBe("active");
	expect(billingStateKind(snapshot({}, { status: "canceled" }))).toBe("canceling");
	expect(billingStateKind(snapshot({ status: "past_due" }))).toBe("past_due");
	expect(billingStateKind(snapshot({ status: "suspended" }))).toBe("suspended");
});

it("counts days up, never below zero", () => {
	expect(daysUntil(day(2), now)).toBe(2);
	expect(daysUntil(day(-3), now)).toBe(0);
	expect(daysUntil(null, now)).toBeNull();
});

it("shows the trial banner only in the last three days", () => {
	expect(ownerBannerKind(snapshot({ status: "trial" }, { trialEndsAt: day(3) }), now)).toBe("trial_ending");
	expect(ownerBannerKind(snapshot({ status: "trial" }, { trialEndsAt: day(4) }), now)).toBeNull();
	expect(ownerBannerKind(snapshot(), now)).toBeNull();
});

it("checks seats against members and the plan limit", () => {
	expect(seatProblem(3, 4, 50)).toBe("below_members");
	expect(seatProblem(4, 4, 50)).toBeNull();
	expect(seatProblem(51, 4, 50)).toBe("over_limit");
	expect(seatProblem(0, 0, null)).toBe("invalid");
	expect(seatProblem(1.5, 0, null)).toBe("invalid");
	expect(seatProblem(500, 4, null)).toBeNull();
});

it("reads the plan table's units: USD in cents, KES in shillings", () => {
	const plan = {
		pricingModel: "per_seat",
		priceMonthlyUsdCents: 1500,
		priceAnnualUsdCents: null,
		priceMonthlyKes: 2000,
		priceAnnualKes: 20_000,
	} as const;
	expect(planPrice(plan, "month", "USD")).toEqual({ amount: 15, perSeat: true });
	expect(planPrice(plan, "month", "KES")).toEqual({ amount: 2000, perSeat: true });
	expect(planPrice(plan, "year", "USD")).toBeNull();
});

it("confirms a payment when the state moved, or when it had already arrived", () => {
	const before = snapshot({ planId: "personal" }, { status: "none", provider: "none", currentPeriodStart: null });
	expect(paymentConfirmed(before, before, now)).toBe(false);
	expect(paymentConfirmed(before, snapshot(), now)).toBe(true);
	const fresh = snapshot({}, { currentPeriodStart: day(0) });
	expect(paymentConfirmed(fresh, fresh, now)).toBe(true);
	const old = snapshot();
	expect(paymentConfirmed(old, old, now)).toBe(false);
});
