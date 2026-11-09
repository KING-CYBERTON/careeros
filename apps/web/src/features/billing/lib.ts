// CAREEROS (P3-T06): the pure parts of the billing page: what state an organization is in, which seat counts are
// allowed, how a price from the plan table is shown, and when the return page may stop waiting. No prices live here:
// every amount shown comes from the plan table through `billing.get` or from a recorded payment.

export type BillingInterval = "month" | "year";
export type PaymentMethod = "card" | "mpesa";
export type Currency = "KES" | "USD";

export type PlanPrices = {
	pricingModel: "flat" | "per_seat";
	priceMonthlyUsdCents: number | null;
	priceAnnualUsdCents: number | null;
	priceMonthlyKes: number | null;
	priceAnnualKes: number | null;
};

/** The parts of `billing.get` the helpers need. */
export type BillingSnapshot = {
	planId: string;
	status: "trial" | "active" | "past_due" | "suspended";
	subscription: {
		status: "trialing" | "active" | "past_due" | "canceled" | "none";
		provider: string;
		seats: number;
		currentPeriodStart: Date | null;
		currentPeriodEnd: Date | null;
		trialEndsAt: Date | null;
		graceEndsAt: Date | null;
	};
};

export type BillingStateKind = "trial" | "active" | "canceling" | "past_due" | "suspended";

/** Which of the five states the summary shows. A canceled subscription still pays its period out, so it is "canceling". */
export function billingStateKind(billing: Pick<BillingSnapshot, "status" | "subscription">): BillingStateKind {
	if (billing.status === "suspended") return "suspended";
	if (billing.status === "past_due") return "past_due";
	if (billing.status === "trial") return "trial";
	if (billing.subscription.status === "canceled") return "canceling";
	return "active";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `now` to `date`, rounded up, never below zero. */
export function daysUntil(date: Date | null, now: Date = new Date()): number | null {
	if (!date) return null;
	return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / DAY_MS));
}

export const TRIAL_WARNING_DAYS = 3;

export type BannerKind = "trial_ending" | "past_due" | "suspended";

/** The banner an owner sees, or null. Past due and suspended always show; a trial shows in its last three days. */
export function ownerBannerKind(billing: BillingSnapshot, now: Date = new Date()): BannerKind | null {
	if (billing.status === "suspended") return "suspended";
	if (billing.status === "past_due") return "past_due";
	if (billing.status === "trial") {
		const days = daysUntil(billing.subscription.trialEndsAt, now);
		return days !== null && days <= TRIAL_WARNING_DAYS ? "trial_ending" : null;
	}
	return null;
}

export type SeatProblem = "invalid" | "below_members" | "over_limit";

/** Seats must be a whole number, at least the people already in the organization, and within the plan's limit. */
export function seatProblem(seats: number, memberCount: number, seatLimit: number | null): SeatProblem | null {
	if (!Number.isInteger(seats) || seats < 1) return "invalid";
	if (seats < memberCount) return "below_members";
	if (seatLimit !== null && seats > seatLimit) return "over_limit";
	return null;
}

/** The smallest seat count to offer: the members already in, and at least one. */
export const minimumSeats = (memberCount: number) => Math.max(1, memberCount);

/**
 * A price from the plan table. The table holds USD in cents and KES in whole shillings; null means "contact us".
 */
export function planPrice(
	plan: PlanPrices,
	interval: BillingInterval,
	currency: Currency,
): { amount: number; perSeat: boolean } | null {
	const raw =
		currency === "USD"
			? interval === "year"
				? plan.priceAnnualUsdCents
				: plan.priceMonthlyUsdCents
			: interval === "year"
				? plan.priceAnnualKes
				: plan.priceMonthlyKes;
	if (raw === null) return null;
	return { amount: currency === "USD" ? raw / 100 : raw, perSeat: plan.pricingModel === "per_seat" };
}

export function formatMoney(amount: number, currency: string, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: "currency",
			currency,
			maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
		}).format(amount);
	} catch {
		return `${amount} ${currency}`;
	}
}

/** A recorded payment's amount: providers report the smallest unit (cents) for every currency we take. */
export function formatPaid(minorUnits: number | null, currency: string | null, locale: string): string | null {
	if (minorUnits === null || currency === null) return null;
	return formatMoney(minorUnits / 100, currency, locale);
}

type StatusSource = Pick<BillingSnapshot, "planId" | "status" | "subscription">;

/** What the return page compares: anything that moves when a payment is applied. */
export function billingFingerprint(billing: StatusSource): string {
	return [
		billing.planId,
		billing.status,
		billing.subscription.status,
		billing.subscription.seats,
		billing.subscription.currentPeriodEnd?.getTime() ?? "none",
	].join("|");
}

/**
 * Whether the payment shows in the plan. True when the state changed since the page opened, or when the page opened
 * after the confirmation already arrived (an active paid subscription whose period started in the last ten minutes).
 */
export function paymentConfirmed(first: StatusSource, current: StatusSource, now: Date = new Date()): boolean {
	if (billingFingerprint(first) !== billingFingerprint(current)) return true;
	const started = current.subscription.currentPeriodStart;
	return (
		current.status === "active" &&
		current.subscription.status === "active" &&
		current.subscription.provider !== "none" &&
		started !== null &&
		now.getTime() - started.getTime() < 10 * 60 * 1000
	);
}

export const CONFIRMATION_TIMEOUT_MS = 60_000;
export const CONFIRMATION_POLL_MS = 3_000;
