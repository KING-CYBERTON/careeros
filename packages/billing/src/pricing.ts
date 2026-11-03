import type { BillingInterval } from "@reactive-resume/db/schema";

// CAREEROS (P3-T04): what a plan costs. Prices live only in the `plan` table (D2); this turns a row into a charge.

export type PlanPrices = {
	id: string;
	pricingModel: string;
	seatLimit: number | null;
	active: boolean;
	priceMonthlyUsdCents: number | null;
	priceAnnualUsdCents: number | null;
	priceMonthlyKes: number | null;
	priceAnnualKes: number | null;
};

export type Currency = "USD" | "KES";

/** The plans an organization can buy itself. `enterprise` is on request, `personal` and `trial` are not sold. */
export const SELF_SERVICE_PLAN_IDS = ["starter", "pro"] as const;

export function isSelfServicePlan(planId: string): boolean {
	return (SELF_SERVICE_PLAN_IDS as readonly string[]).includes(planId);
}

/**
 * The amount for `seats` seats on `plan` for one `interval`, in the smallest unit the provider reports: USD cents, and
 * for KES the whole shillings of the plan table times 100 (Q191 keeps KES prices in whole shillings; providers report
 * KES in cents). Null when the plan has no price for that interval and currency (contact us).
 */
export function priceFor(
	plan: PlanPrices,
	interval: BillingInterval,
	seats: number,
	currency: Currency,
): number | null {
	const unit =
		currency === "USD"
			? interval === "month"
				? plan.priceMonthlyUsdCents
				: plan.priceAnnualUsdCents
			: interval === "month"
				? plan.priceMonthlyKes
				: plan.priceAnnualKes;
	if (unit === null) return null;
	const major = plan.pricingModel === "per_seat" ? unit * seats : unit;
	return currency === "KES" ? major * 100 : major;
}
