import type { BillingEvent } from "./events";
import type { BillingInterval, OrganizationStatus } from "@reactive-resume/db/schema";
import { TRIAL_DAYS } from "./entitlements";

// CAREEROS (P3-T04, phase plan D9): the one subscription state machine. `nextState` is a pure function: it reads the
// current state, one event and the time, and answers what to write and what to audit. It touches no database, so every
// transition (out-of-order and duplicate events included) is unit-tested. `applyTransition` (apply.ts) writes the answer
// through the definer functions of P3-T01.

/** Days a past-due organization keeps working before it is suspended. */
export const GRACE_DAYS = 7;
/** Seats of a new trial (the `trial` plan's seat limit). */
export const TRIAL_SEATS = 5;
export const TRIAL_PLAN_ID = "trial";
export const PERSONAL_PLAN_ID = "personal";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SubscriptionState = {
	provider: string;
	status: string;
	seats: number;
	interval: BillingInterval | null;
	providerCustomerId: string | null;
	providerSubscriptionId: string | null;
	periodStart: Date | null;
	periodEnd: Date | null;
	trialEndsAt: Date | null;
	graceEndsAt: Date | null;
	/** CAREEROS (P3-T05): a seat change that starts with the next paid period (see the `subscription` table). */
	pendingSeats?: number | null;
	pendingReplacesSubscriptionId?: string | null;
};

/** Everything the machine needs to know about one organization. */
export type BillingState = {
	orgStatus: string;
	planId: string;
	subscription: SubscriptionState;
	/** Members only (pending invitations are not members). */
	memberCount: number;
};

/** The two events that do not come from a provider: starting a trial, and the clock reaching a deadline (the job). */
export type InternalEvent = { type: "trial.started" } | { type: "time.passed" };
export type StateEvent = BillingEvent | InternalEvent;

export type SubscriptionPatch = Partial<SubscriptionState>;
export type AuditEntry = { action: string; metadata: Record<string, unknown> };

export type Transition = {
	/** False when the event changes nothing and nothing is audited (stale, not applicable, or nothing due). */
	applied: boolean;
	/** Why it was not applied, or a note when it was. */
	reason: string | null;
	/** The organization's new plan, or null to leave it. */
	planId: string | null;
	/** The organization's new status, or null to leave it. */
	orgStatus: OrganizationStatus | null;
	/** Only the subscription fields that change. */
	subscription: SubscriptionPatch;
	audit: AuditEntry[];
};

const notApplied = (reason: string): Transition => ({
	applied: false,
	reason,
	planId: null,
	orgStatus: null,
	subscription: {},
	audit: [],
});

const same = (a: unknown, b: unknown) =>
	a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

/** Keeps only the fields of `wanted` that differ from `current`, so an unchanged field is never written or audited. */
function diff(current: SubscriptionState, wanted: SubscriptionPatch): SubscriptionPatch {
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(wanted) as [keyof SubscriptionState, unknown][]) {
		if (value !== undefined && !same(current[key], value)) patch[key] = value;
	}
	return patch as SubscriptionPatch;
}

/** An event whose period ends before the one we already hold describes the past; it must not overwrite the present. */
function isStale(state: BillingState, event: BillingEvent): boolean {
	const held = state.subscription.periodEnd;
	return held !== null && event.periodEnd !== null && event.periodEnd.getTime() < held.getTime();
}

function eventAudit(action: string, event: BillingEvent, extra: Record<string, unknown> = {}): AuditEntry {
	return {
		action,
		metadata: {
			source: event.provider,
			eventType: event.type,
			providerEventId: event.providerEventId,
			planId: event.planId,
			seats: event.seats,
			amount: event.amount,
			currency: event.currency,
			// CAREEROS (P3-T06): the billing page lists payments from these audit rows, with the period each one paid for.
			interval: event.interval,
			periodStart: event.periodStart?.toISOString() ?? null,
			periodEnd: event.periodEnd?.toISOString() ?? null,
			...extra,
		},
	};
}

/** `seats` below the members never removes anyone: the members stay and the shortfall is audited (spec). */
function seatWarning(event: BillingEvent, seats: number, members: number): AuditEntry[] {
	return seats < members
		? [eventAudit("billing.seats_below_members", event, { seatsPaid: seats, members, membersKept: true })]
		: [];
}

function fromPayment(state: BillingState, event: BillingEvent): Transition {
	if (isStale(state, event)) return notApplied("stale_event");
	const current = state.subscription;
	const seats = event.seats ?? current.seats;
	const planId = event.planId ?? state.planId;
	const subscription = diff(current, {
		provider: event.provider,
		status: "active",
		seats,
		interval: event.interval ?? current.interval,
		periodStart: event.periodStart ?? current.periodStart,
		periodEnd: event.periodEnd ?? current.periodEnd,
		graceEndsAt: null,
		providerCustomerId: event.providerCustomerId ?? current.providerCustomerId,
		providerSubscriptionId: event.providerSubscriptionId ?? current.providerSubscriptionId,
		// CAREEROS (P3-T05): the payment for the pending seat count has arrived, so the change has taken effect.
		...(current.pendingSeats != null && event.seats === current.pendingSeats
			? { pendingSeats: null, pendingReplacesSubscriptionId: null }
			: {}),
	});
	return {
		applied: true,
		reason: null,
		planId: planId === state.planId ? null : planId,
		orgStatus: state.orgStatus === "active" ? null : "active",
		subscription,
		audit: [
			eventAudit(
				event.type === "checkout.completed" ? "billing.checkout_completed" : "billing.payment_succeeded",
				event,
			),
			...seatWarning(event, seats, state.memberCount),
		],
	};
}

function fromUpdate(state: BillingState, event: BillingEvent): Transition {
	if (isStale(state, event)) return notApplied("stale_event");
	const current = state.subscription;
	const seats = event.seats ?? current.seats;
	const planId = event.planId ?? state.planId;
	return {
		applied: true,
		reason: null,
		planId: planId === state.planId ? null : planId,
		orgStatus: null,
		subscription: diff(current, {
			seats,
			interval: event.interval ?? current.interval,
			periodStart: event.periodStart ?? current.periodStart,
			periodEnd: event.periodEnd ?? current.periodEnd,
			providerCustomerId: event.providerCustomerId ?? current.providerCustomerId,
			providerSubscriptionId: event.providerSubscriptionId ?? current.providerSubscriptionId,
		}),
		audit: [eventAudit("billing.subscription_updated", event), ...seatWarning(event, seats, state.memberCount)],
	};
}

function fromFailure(state: BillingState, event: BillingEvent, now: Date): Transition {
	const current = state.subscription;
	// Only an organization that has been paying can fall behind. A failed first payment leaves a trial running, a
	// suspended organization suspended and a canceled subscription canceled; the failure is still audited.
	const paying = current.status === "active" || current.status === "past_due";
	if (!paying || state.orgStatus === "suspended")
		return {
			applied: true,
			reason: "no_state_change",
			planId: null,
			orgStatus: null,
			subscription: {},
			audit: [eventAudit("billing.payment_failed", event, { stateChanged: false })],
		};
	return {
		applied: true,
		reason: null,
		planId: null,
		orgStatus: state.orgStatus === "past_due" ? null : "past_due",
		// Not extended by a second failure: the grace period runs from the first one.
		subscription: diff(current, {
			status: "past_due",
			graceEndsAt: current.graceEndsAt ?? new Date(now.getTime() + GRACE_DAYS * DAY_MS),
		}),
		audit: [eventAudit("billing.payment_failed", event, { stateChanged: true })],
	};
}

function fromCancellation(state: BillingState, event: BillingEvent, now: Date): Transition {
	if (isStale(state, event)) return notApplied("stale_event");
	const current = state.subscription;
	if (current.status !== "active" && current.status !== "past_due" && current.status !== "canceled")
		return notApplied("no_subscription");
	// CAREEROS (P3-T05): a cancellation names a provider subscription. One we replaced (a seat change starts a new
	// subscription and disables the old one) or one that is no longer ours is not the customer cancelling.
	const named = event.providerSubscriptionId ?? null;
	if (named !== null && named === (current.pendingReplacesSubscriptionId ?? null))
		return notApplied("replaced_subscription");
	if (named !== null && current.providerSubscriptionId !== null && named !== current.providerSubscriptionId)
		return notApplied("other_subscription");
	return {
		applied: true,
		reason: null,
		planId: null,
		// The organization keeps working until the paid period ends; the job suspends it then.
		orgStatus: null,
		subscription: diff(current, {
			status: "canceled",
			periodEnd: event.periodEnd ?? current.periodEnd ?? now,
		}),
		audit: [eventAudit("billing.subscription_canceled", event)],
	};
}

function startTrial(state: BillingState, now: Date): Transition {
	if (state.planId !== PERSONAL_PLAN_ID || state.orgStatus !== "active") return notApplied("not_on_personal_plan");
	// Once per organization: a trial leaves its end date behind for good.
	if (state.subscription.trialEndsAt !== null || state.subscription.status !== "none") return notApplied("trial_used");
	const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
	return {
		applied: true,
		reason: null,
		planId: TRIAL_PLAN_ID,
		orgStatus: "trial",
		subscription: {
			status: "trialing",
			seats: TRIAL_SEATS,
			trialEndsAt,
			graceEndsAt: null,
		},
		audit: [
			{
				action: "billing.trial_started",
				metadata: { source: "trial", trialEndsAt: trialEndsAt.toISOString(), seats: TRIAL_SEATS, days: TRIAL_DAYS },
			},
		],
	};
}

/** Providers whose customers pay one period at a time when they have no provider subscription (P3-T05). */
const ONE_PERIOD_PROVIDERS = ["paystack"];

export function isOnePeriodPlan(sub: Pick<SubscriptionState, "provider" | "providerSubscriptionId">): boolean {
	return ONE_PERIOD_PROVIDERS.includes(sub.provider) && sub.providerSubscriptionId === null;
}

function timePassed(state: BillingState, now: Date): Transition {
	const { subscription: sub } = state;
	if (state.orgStatus === "suspended") return notApplied("already_suspended");
	const at = now.getTime();
	if (state.orgStatus === "trial" && sub.trialEndsAt !== null && sub.trialEndsAt.getTime() <= at)
		return {
			applied: true,
			reason: null,
			planId: null,
			orgStatus: "suspended",
			subscription: diff(sub, { status: "canceled" }),
			audit: [
				{ action: "billing.trial_expired", metadata: { source: "job", trialEndsAt: sub.trialEndsAt.toISOString() } },
			],
		};
	if (state.orgStatus === "past_due" && sub.graceEndsAt !== null && sub.graceEndsAt.getTime() <= at)
		return {
			applied: true,
			reason: null,
			planId: null,
			orgStatus: "suspended",
			subscription: {},
			audit: [
				{ action: "billing.grace_expired", metadata: { source: "job", graceEndsAt: sub.graceEndsAt.toISOString() } },
			],
		};
	// CAREEROS (P3-T05): a plan paid one period at a time (Paystack with M-Pesa has no provider subscription, so nothing
	// renews it and no provider event ever says the period ended) lapses into the grace period when its paid period ends
	// unpaid, like a failed card renewal.
	if (
		state.orgStatus === "active" &&
		sub.status === "active" &&
		isOnePeriodPlan(sub) &&
		sub.periodEnd !== null &&
		sub.periodEnd.getTime() <= at
	)
		return {
			applied: true,
			reason: null,
			planId: null,
			orgStatus: "past_due",
			subscription: diff(sub, {
				status: "past_due",
				graceEndsAt: sub.graceEndsAt ?? new Date(at + GRACE_DAYS * DAY_MS),
			}),
			audit: [
				{ action: "billing.period_expired", metadata: { source: "job", periodEnd: sub.periodEnd.toISOString() } },
			],
		};
	// A canceled subscription runs to the end of the period that was paid for (no known end means it has ended).
	if (sub.status === "canceled" && (sub.periodEnd === null || sub.periodEnd.getTime() <= at))
		return {
			applied: true,
			reason: null,
			planId: null,
			orgStatus: "suspended",
			subscription: {},
			audit: [
				{
					action: "billing.subscription_ended",
					metadata: { source: "job", periodEnd: sub.periodEnd?.toISOString() ?? null },
				},
			],
		};
	return notApplied("nothing_due");
}

/**
 * The state machine. `current` is read under the organization's billing lock; the result is applied by
 * `applyTransition`. Rules (spec P3-T04, requirement 2):
 *
 * - `trial.started`: a personal-plan organization that never trialed becomes `trial` on the trial plan, 5 seats, ending
 *   `TRIAL_DAYS` from now.
 * - `checkout.completed` / `payment.succeeded`: `active`, plan and seats and period from the event, grace cleared. This
 *   also revives a suspended organization.
 * - `payment.failed`: `past_due` with a grace end `GRACE_DAYS` out (kept if already set), for a paying organization.
 * - `time.passed` (the job): trial ended, grace ended, or a canceled subscription's period ended: `suspended`.
 * - `subscription.canceled`: the subscription is `canceled` and the organization stays as it is until the period ends.
 * - `subscription.updated`: plan, seats and period change; the status does not.
 * - An event whose `periodEnd` is older than the one held is `stale_event` and changes nothing. Seats below the member
 *   count are kept and audited; members are never removed.
 */
export function nextState(current: BillingState, event: StateEvent, now: Date): Transition {
	switch (event.type) {
		case "trial.started":
			return startTrial(current, now);
		case "time.passed":
			return timePassed(current, now);
		case "checkout.completed":
		case "payment.succeeded":
			return fromPayment(current, event);
		case "payment.failed":
			return fromFailure(current, event, now);
		case "subscription.updated":
			return fromUpdate(current, event);
		case "subscription.canceled":
			return fromCancellation(current, event, now);
	}
}
