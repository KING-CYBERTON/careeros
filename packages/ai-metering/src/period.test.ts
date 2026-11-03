import { describe, expect, it } from "vite-plus/test";
import { calendarMonthUtc, quotaPeriod } from "./period";
import { evaluateQuota } from "./quota";

const at = (iso: string) => new Date(iso);

describe("quotaPeriod", () => {
	it("uses the subscription's current period while it contains now", () => {
		const period = quotaPeriod(
			{ currentPeriodStart: at("2026-10-15T00:00:00Z"), currentPeriodEnd: at("2026-11-15T00:00:00Z") },
			at("2026-11-02T12:00:00Z"),
		);
		expect(period).toEqual({
			start: at("2026-10-15T00:00:00Z"),
			end: at("2026-11-15T00:00:00Z"),
			source: "subscription",
		});
	});

	it("is half open: the start belongs to the period, the end does not", () => {
		const sub = { currentPeriodStart: at("2026-10-15T00:00:00Z"), currentPeriodEnd: at("2026-11-15T00:00:00Z") };
		expect(quotaPeriod(sub, at("2026-10-15T00:00:00Z")).source).toBe("subscription");
		expect(quotaPeriod(sub, at("2026-11-15T00:00:00Z")).source).toBe("calendar_month");
	});

	it("falls back to the calendar month in UTC without a usable subscription period", () => {
		const now = at("2026-11-30T23:59:59Z");
		const month = { start: at("2026-11-01T00:00:00Z"), end: at("2026-12-01T00:00:00Z"), source: "calendar_month" };
		expect(quotaPeriod(null, now)).toEqual(month);
		expect(quotaPeriod(undefined, now)).toEqual(month);
		expect(quotaPeriod({ currentPeriodStart: null, currentPeriodEnd: null }, now)).toEqual(month);
		// A stored period that ended, or has not started, or runs backwards, is not used.
		expect(
			quotaPeriod(
				{ currentPeriodStart: at("2026-09-01T00:00:00Z"), currentPeriodEnd: at("2026-10-01T00:00:00Z") },
				now,
			),
		).toEqual(month);
		expect(
			quotaPeriod(
				{ currentPeriodStart: at("2026-12-01T00:00:00Z"), currentPeriodEnd: at("2027-01-01T00:00:00Z") },
				now,
			),
		).toEqual(month);
		expect(
			quotaPeriod(
				{ currentPeriodStart: at("2026-12-01T00:00:00Z"), currentPeriodEnd: at("2026-10-01T00:00:00Z") },
				now,
			),
		).toEqual(month);
	});

	it("rolls the calendar month over the year end", () => {
		expect(calendarMonthUtc(at("2026-12-31T23:00:00Z"))).toMatchObject({
			start: at("2026-12-01T00:00:00Z"),
			end: at("2027-01-01T00:00:00Z"),
		});
	});
});

describe("evaluateQuota", () => {
	const period = calendarMonthUtc(at("2026-11-02T00:00:00Z"));
	const state = (used: number, allowance: number, overageAllowed = false) =>
		evaluateQuota({ used, allowance, overageAllowed, period });

	it("warns from 80% and blocks from 100%", () => {
		expect(state(79, 100)).toMatchObject({ warning: false, exceeded: false, blocked: false });
		expect(state(80, 100)).toMatchObject({ warning: true, exceeded: false, blocked: false });
		expect(state(99, 100)).toMatchObject({ warning: true, exceeded: false, blocked: false });
		expect(state(100, 100)).toMatchObject({ warning: true, exceeded: true, blocked: true });
		expect(state(150, 100)).toMatchObject({ exceeded: true, blocked: true });
	});

	it("lets an organization with overage allowed carry on past 100%", () => {
		expect(state(150, 100, true)).toMatchObject({ exceeded: true, blocked: false });
	});

	it("treats a zero allowance as used up, without a warning", () => {
		expect(state(0, 0)).toMatchObject({ warning: false, exceeded: true, blocked: true });
		expect(state(0, 0, true).blocked).toBe(false);
	});
});
