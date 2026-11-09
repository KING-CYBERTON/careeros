import type { BillingEvent } from "./events";
import { describe, expect, it } from "vite-plus/test";
import { GRACE_DAYS, nextState, TRIAL_SEATS, type BillingState } from "./state";

// P3-T04: every transition of the subscription state machine, including duplicate and out-of-order events. The machine
// is pure, so none of this needs a database.

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-02T12:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const personal = (): BillingState => ({
	orgStatus: "active",
	planId: "personal",
	memberCount: 1,
	subscription: {
		provider: "none",
		status: "none",
		seats: 1,
		interval: null,
		providerCustomerId: null,
		providerSubscriptionId: null,
		periodStart: null,
		periodEnd: null,
		trialEndsAt: null,
		graceEndsAt: null,
	},
});

const trialing = (): BillingState => ({
	...personal(),
	orgStatus: "trial",
	planId: "trial",
	subscription: { ...personal().subscription, status: "trialing", seats: TRIAL_SEATS, trialEndsAt: at(14) },
});

const paying = (overrides: Partial<BillingState["subscription"]> = {}, memberCount = 3): BillingState => ({
	orgStatus: "active",
	planId: "starter",
	memberCount,
	subscription: {
		provider: "fake",
		status: "active",
		seats: 10,
		interval: "month",
		providerCustomerId: "cus_1",
		providerSubscriptionId: "sub_1",
		periodStart: at(-10),
		periodEnd: at(20),
		trialEndsAt: at(-30),
		graceEndsAt: null,
		...overrides,
	},
});

let counter = 0;
const event = (type: BillingEvent["type"], overrides: Partial<BillingEvent> = {}): BillingEvent => ({
	type,
	provider: "fake",
	providerEventId: `evt_${++counter}`,
	orgId: "org_1",
	planId: null,
	seats: null,
	interval: null,
	periodStart: null,
	periodEnd: null,
	amount: null,
	currency: null,
	...overrides,
});

describe("trial.started", () => {
	it("moves a personal organization to a 14-day trial with 5 seats", () => {
		const t = nextState(personal(), { type: "trial.started" }, NOW);
		expect(t).toMatchObject({ applied: true, planId: "trial", orgStatus: "trial" });
		expect(t.subscription).toEqual({ status: "trialing", seats: TRIAL_SEATS, trialEndsAt: at(14), graceEndsAt: null });
		expect(t.audit.map((a) => a.action)).toEqual(["billing.trial_started"]);
	});

	it("is refused a second time (the end date stays on the subscription)", () => {
		const used = { ...personal(), subscription: { ...personal().subscription, trialEndsAt: at(-3) } };
		expect(nextState(used, { type: "trial.started" }, NOW)).toMatchObject({ applied: false, reason: "trial_used" });
	});

	it("is refused for an organization that is already on a paid plan or trial", () => {
		expect(nextState(trialing(), { type: "trial.started" }, NOW)).toMatchObject({ applied: false });
		expect(nextState(paying(), { type: "trial.started" }, NOW)).toMatchObject({
			applied: false,
			reason: "not_on_personal_plan",
		});
	});
});

describe("checkout.completed and payment.succeeded", () => {
	const paid = (type: "checkout.completed" | "payment.succeeded") =>
		event(type, {
			planId: "starter",
			seats: 10,
			interval: "month",
			periodStart: NOW,
			periodEnd: at(30),
			amount: 4900,
			currency: "USD",
			providerCustomerId: "cus_1",
			providerSubscriptionId: "sub_1",
		});

	it.each(["checkout.completed", "payment.succeeded"] as const)("%s activates a trial organization", (type) => {
		const t = nextState(trialing(), paid(type), NOW);
		expect(t).toMatchObject({ applied: true, planId: "starter", orgStatus: "active" });
		expect(t.subscription).toMatchObject({
			provider: "fake",
			status: "active",
			seats: 10,
			interval: "month",
			periodStart: NOW,
			periodEnd: at(30),
			providerCustomerId: "cus_1",
			providerSubscriptionId: "sub_1",
		});
		expect(t.audit[0]?.action).toBe(
			type === "checkout.completed" ? "billing.checkout_completed" : "billing.payment_succeeded",
		);
		expect(t.audit[0]?.metadata).toMatchObject({ source: "fake", amount: 4900, currency: "USD" });
	});

	it("clears the grace period and returns a past-due organization to active", () => {
		const state = { ...paying({ status: "past_due", graceEndsAt: at(3) }), orgStatus: "past_due" };
		const t = nextState(state, paid("payment.succeeded"), NOW);
		expect(t.orgStatus).toBe("active");
		expect(t.subscription).toMatchObject({ status: "active", graceEndsAt: null });
	});

	it("revives a suspended organization", () => {
		const state = { ...paying({ status: "past_due", graceEndsAt: at(-1) }), orgStatus: "suspended" };
		expect(nextState(state, paid("payment.succeeded"), NOW)).toMatchObject({ applied: true, orgStatus: "active" });
	});

	it("keeps the plan and seats it already has when the event does not name them", () => {
		const t = nextState(paying(), event("payment.succeeded", { periodEnd: at(50) }), NOW);
		expect(t.planId).toBeNull();
		expect(t.subscription).toEqual({ periodEnd: at(50) });
	});

	it("applies a renewal with a newer period end", () => {
		const t = nextState(paying(), event("payment.succeeded", { periodStart: at(20), periodEnd: at(50) }), NOW);
		expect(t.subscription).toEqual({ periodStart: at(20), periodEnd: at(50) });
	});

	it("a repeated payment for the same period changes nothing but is still audited", () => {
		const t = nextState(paying(), event("payment.succeeded", { periodStart: at(-10), periodEnd: at(20) }), NOW);
		expect(t.applied).toBe(true);
		expect(t.subscription).toEqual({});
		expect(t.orgStatus).toBeNull();
	});

	it("ignores a payment for an older period than the one held (out of order)", () => {
		const t = nextState(
			paying(),
			event("payment.succeeded", { periodStart: at(-40), periodEnd: at(-10), seats: 2 }),
			NOW,
		);
		expect(t).toMatchObject({ applied: false, reason: "stale_event", subscription: {}, audit: [] });
	});
});

describe("seats below the member count", () => {
	it("keeps the seats the provider says, keeps every member and records a warning", () => {
		const t = nextState(paying({}, 8), event("subscription.updated", { seats: 5 }), NOW);
		expect(t.subscription).toEqual({ seats: 5 });
		expect(t.audit.map((a) => a.action)).toEqual(["billing.subscription_updated", "billing.seats_below_members"]);
		expect(t.audit[1]?.metadata).toMatchObject({ seatsPaid: 5, members: 8, membersKept: true });
	});

	it("also warns on a payment that sets fewer seats than members", () => {
		const t = nextState(paying({}, 12), event("payment.succeeded", { seats: 10 }), NOW);
		expect(t.audit.map((a) => a.action)).toContain("billing.seats_below_members");
	});

	it("does not warn when the seats cover the members", () => {
		const t = nextState(paying({}, 5), event("subscription.updated", { seats: 5 }), NOW);
		expect(t.audit.map((a) => a.action)).toEqual(["billing.subscription_updated"]);
	});
});

describe("payment.failed", () => {
	it("moves a paying organization to past_due with a 7-day grace period", () => {
		const t = nextState(paying(), event("payment.failed"), NOW);
		expect(t).toMatchObject({ applied: true, orgStatus: "past_due" });
		expect(t.subscription).toEqual({ status: "past_due", graceEndsAt: at(GRACE_DAYS) });
		expect(t.audit[0]?.action).toBe("billing.payment_failed");
	});

	it("does not extend a grace period that is already running", () => {
		const state = { ...paying({ status: "past_due", graceEndsAt: at(2) }), orgStatus: "past_due" };
		const t = nextState(state, event("payment.failed"), at(5));
		expect(t.orgStatus).toBeNull();
		expect(t.subscription).toEqual({});
	});

	it("a duplicate failure (new event id) changes nothing", () => {
		const first = nextState(paying(), event("payment.failed"), NOW);
		const after: BillingState = {
			...paying({ status: "past_due", graceEndsAt: at(GRACE_DAYS) }),
			orgStatus: "past_due",
		};
		expect(first.orgStatus).toBe("past_due");
		const second = nextState(after, event("payment.failed"), at(1));
		expect(second.subscription).toEqual({});
		expect(second.orgStatus).toBeNull();
	});

	it("leaves a trial running, a suspended organization suspended and a canceled one canceled", () => {
		for (const state of [
			trialing(),
			{ ...paying(), orgStatus: "suspended" },
			paying({ status: "canceled" }),
			personal(),
		]) {
			const t = nextState(state, event("payment.failed"), NOW);
			expect(t).toMatchObject({ applied: true, orgStatus: null, subscription: {}, reason: "no_state_change" });
		}
	});
});

describe("subscription.canceled", () => {
	it("marks the subscription canceled and keeps the organization active until the period ends", () => {
		const t = nextState(paying(), event("subscription.canceled", { periodEnd: at(20) }), NOW);
		expect(t.orgStatus).toBeNull();
		expect(t.subscription).toEqual({ status: "canceled" });
		expect(t.audit[0]?.action).toBe("billing.subscription_canceled");
	});

	it("takes the end of the paid period from the event when it differs", () => {
		const t = nextState(paying(), event("subscription.canceled", { periodEnd: at(25) }), NOW);
		expect(t.subscription).toEqual({ status: "canceled", periodEnd: at(25) });
	});

	it("is ignored for an organization that is not subscribed", () => {
		expect(nextState(personal(), event("subscription.canceled"), NOW)).toMatchObject({
			applied: false,
			reason: "no_subscription",
		});
		expect(nextState(trialing(), event("subscription.canceled"), NOW).applied).toBe(false);
	});

	it("an older cancel arriving after a newer renewal is ignored", () => {
		const renewed = paying({ periodEnd: at(50) });
		expect(nextState(renewed, event("subscription.canceled", { periodEnd: at(20) }), NOW)).toMatchObject({
			applied: false,
			reason: "stale_event",
		});
	});

	it("a payment after a cancel starts the subscription again", () => {
		const canceled = paying({ status: "canceled" });
		const t = nextState(canceled, event("payment.succeeded", { periodStart: at(20), periodEnd: at(50) }), NOW);
		expect(t.subscription).toMatchObject({ status: "active" });
	});
});

describe("subscription.updated", () => {
	it("changes plan, seats and period but never the status", () => {
		const state = { ...paying({ status: "past_due", graceEndsAt: at(2) }), orgStatus: "past_due" };
		const t = nextState(state, event("subscription.updated", { planId: "pro", seats: 20, periodEnd: at(40) }), NOW);
		expect(t.planId).toBe("pro");
		expect(t.orgStatus).toBeNull();
		expect(t.subscription).toEqual({ seats: 20, periodEnd: at(40) });
	});

	it("an older update must not overwrite a newer period end", () => {
		const t = nextState(
			paying({ periodEnd: at(60) }),
			event("subscription.updated", { seats: 99, periodEnd: at(30) }),
			NOW,
		);
		expect(t).toMatchObject({ applied: false, reason: "stale_event" });
	});
});

describe("time.passed (the job)", () => {
	it("suspends a trial that has ended, and ends its subscription", () => {
		const t = nextState(trialing(), { type: "time.passed" }, at(15));
		expect(t).toMatchObject({ applied: true, orgStatus: "suspended" });
		expect(t.subscription).toEqual({ status: "canceled" });
		expect(t.audit[0]?.action).toBe("billing.trial_expired");
	});

	it("leaves a trial that is still running", () => {
		expect(nextState(trialing(), { type: "time.passed" }, at(13))).toMatchObject({
			applied: false,
			reason: "nothing_due",
		});
	});

	it("suspends a past-due organization when the grace period has passed, not before", () => {
		const state = { ...paying({ status: "past_due", graceEndsAt: at(7) }), orgStatus: "past_due" };
		expect(nextState(state, { type: "time.passed" }, at(6)).applied).toBe(false);
		const t = nextState(state, { type: "time.passed" }, at(7));
		expect(t).toMatchObject({ applied: true, orgStatus: "suspended" });
		expect(t.audit[0]?.action).toBe("billing.grace_expired");
	});

	it("ends a canceled subscription at the end of its period", () => {
		const state = paying({ status: "canceled", periodEnd: at(20) });
		expect(nextState(state, { type: "time.passed" }, at(19)).applied).toBe(false);
		const t = nextState(state, { type: "time.passed" }, at(20));
		expect(t).toMatchObject({ applied: true, orgStatus: "suspended" });
		expect(t.audit[0]?.action).toBe("billing.subscription_ended");
	});

	it("treats a canceled subscription with no known period end as ended", () => {
		const state = paying({ status: "canceled", periodEnd: null });
		expect(nextState(state, { type: "time.passed" }, NOW)).toMatchObject({ applied: true, orgStatus: "suspended" });
	});

	it("is idempotent: a suspended organization is left alone", () => {
		const state = { ...paying({ status: "canceled", periodEnd: at(-1) }), orgStatus: "suspended" };
		expect(nextState(state, { type: "time.passed" }, NOW)).toMatchObject({
			applied: false,
			reason: "already_suspended",
		});
	});

	it("leaves a healthy active organization alone", () => {
		expect(nextState(paying(), { type: "time.passed" }, at(100)).applied).toBe(false);
	});

	it("a personal organization is never touched", () => {
		expect(nextState(personal(), { type: "time.passed" }, at(1000)).applied).toBe(false);
	});
});

describe("the full lifecycle in order", () => {
	it("trial, subscribe, fail, grace, suspended, pay again", () => {
		let state = personal();
		const step = (e: Parameters<typeof nextState>[1], now: Date) => {
			const t = nextState(state, e, now);
			if (!t.applied) return t;
			state = {
				...state,
				planId: t.planId ?? state.planId,
				orgStatus: t.orgStatus ?? state.orgStatus,
				subscription: { ...state.subscription, ...t.subscription },
			};
			return t;
		};
		step({ type: "trial.started" }, NOW);
		expect(state).toMatchObject({ orgStatus: "trial", planId: "trial" });
		step(
			event("checkout.completed", {
				planId: "starter",
				seats: 10,
				interval: "month",
				periodStart: at(1),
				periodEnd: at(31),
			}),
			at(1),
		);
		expect(state).toMatchObject({ orgStatus: "active", planId: "starter" });
		step(event("payment.failed"), at(31));
		expect(state.orgStatus).toBe("past_due");
		step({ type: "time.passed" }, at(37));
		expect(state.orgStatus).toBe("past_due");
		step({ type: "time.passed" }, at(38));
		expect(state.orgStatus).toBe("suspended");
		step(event("payment.succeeded", { periodStart: at(40), periodEnd: at(70) }), at(40));
		expect(state).toMatchObject({ orgStatus: "active" });
		expect(state.subscription.graceEndsAt).toBeNull();
	});
});

// P3-T05: plans paid one period at a time (Paystack with M-Pesa), and seat changes that start with the next period.
describe("one-period plans (Paystack, M-Pesa)", () => {
	const mpesa = (overrides: Partial<BillingState["subscription"]> = {}) =>
		paying({ provider: "paystack", providerSubscriptionId: null, ...overrides });

	it("lapses into the grace period when the paid period ends unpaid, then is suspended", () => {
		const state = mpesa({ periodEnd: at(0) });
		const lapsed = nextState(state, { type: "time.passed" }, at(0));
		expect(lapsed).toMatchObject({ applied: true, orgStatus: "past_due" });
		expect(lapsed.subscription).toEqual({ status: "past_due", graceEndsAt: at(GRACE_DAYS) });
		expect(lapsed.audit[0]?.action).toBe("billing.period_expired");
		const later = {
			...state,
			orgStatus: "past_due",
			subscription: { ...state.subscription, ...lapsed.subscription },
		};
		expect(nextState(later, { type: "time.passed" }, at(GRACE_DAYS - 1)).applied).toBe(false);
		expect(nextState(later, { type: "time.passed" }, at(GRACE_DAYS))).toMatchObject({
			applied: true,
			orgStatus: "suspended",
		});
	});

	it("does nothing before the period ends", () => {
		expect(nextState(mpesa({ periodEnd: at(1) }), { type: "time.passed" }, at(0))).toMatchObject({
			applied: false,
			reason: "nothing_due",
		});
	});

	it("does not touch a card subscription (the provider sends payment.failed) or a manual or fake payment", () => {
		for (const sub of [
			{ provider: "paystack", providerSubscriptionId: "SUB_1" },
			{ provider: "fake", providerSubscriptionId: null },
			{ provider: "manual", providerSubscriptionId: null },
		])
			expect(nextState(paying({ ...sub, periodEnd: at(-1) }), { type: "time.passed" }, at(0)).applied).toBe(false);
	});

	it("a payment after the lapse makes it active again and clears the grace period", () => {
		const lapsed = { ...mpesa({ status: "past_due", periodEnd: at(0), graceEndsAt: at(5) }), orgStatus: "past_due" };
		const t = nextState(
			lapsed,
			event("checkout.completed", {
				provider: "paystack",
				planId: "starter",
				seats: 10,
				interval: "month",
				periodStart: at(2),
				periodEnd: at(32),
			}),
			at(2),
		);
		expect(t.orgStatus).toBe("active");
		expect(t.subscription).toMatchObject({ status: "active", graceEndsAt: null, periodEnd: at(32) });
	});
});

describe("seat changes that start with the next period", () => {
	const pending = (overrides: Partial<BillingState["subscription"]> = {}) =>
		paying({
			provider: "paystack",
			providerSubscriptionId: "SUB_old",
			pendingSeats: 12,
			pendingReplacesSubscriptionId: "SUB_old",
			...overrides,
		});

	it("the cancellation of the replaced subscription is not the customer cancelling", () => {
		const t = nextState(pending(), event("subscription.canceled", { providerSubscriptionId: "SUB_old" }), NOW);
		expect(t).toMatchObject({ applied: false, reason: "replaced_subscription" });
	});

	it("a cancellation of a subscription that is no longer the organization's is ignored", () => {
		const state = pending({
			providerSubscriptionId: "SUB_new",
			pendingReplacesSubscriptionId: null,
			pendingSeats: null,
		});
		expect(nextState(state, event("subscription.canceled", { providerSubscriptionId: "SUB_old" }), NOW)).toMatchObject({
			applied: false,
			reason: "other_subscription",
		});
	});

	it("the customer cancelling the current subscription still cancels", () => {
		const state = pending({ providerSubscriptionId: "SUB_new", pendingReplacesSubscriptionId: "SUB_old" });
		const t = nextState(state, event("subscription.canceled", { providerSubscriptionId: "SUB_new" }), NOW);
		expect(t).toMatchObject({ applied: true });
		expect(t.subscription).toEqual({ status: "canceled" });
	});

	it("a cancellation that names no subscription still applies (the fake provider and M-Pesa)", () => {
		expect(nextState(pending(), event("subscription.canceled"), NOW).applied).toBe(true);
	});

	it("the payment for the new seat count takes effect and clears the pending change", () => {
		const t = nextState(
			pending(),
			event("payment.succeeded", {
				provider: "paystack",
				seats: 12,
				planId: "starter",
				interval: "month",
				periodStart: at(20),
				periodEnd: at(50),
			}),
			at(20),
		);
		expect(t.subscription).toMatchObject({ seats: 12, pendingSeats: null, pendingReplacesSubscriptionId: null });
	});

	it("a payment for the old seat count leaves the pending change in place", () => {
		const t = nextState(
			pending(),
			event("payment.succeeded", { provider: "paystack", seats: 10, periodStart: at(20), periodEnd: at(50) }),
			at(20),
		);
		expect(t.subscription).not.toHaveProperty("pendingSeats");
	});
});
