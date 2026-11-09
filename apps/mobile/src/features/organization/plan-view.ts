// CAREEROS (P3-T06, phase plan D10): the pure rules of the read-only Plan screen, tested without React Native. The screen
// has no prices and no purchase path of any kind: app store rules restrict selling subscriptions outside in-app purchase,
// so owners buy and change plans on the web. Nothing here may name an amount, a checkout or a link to one.

export type PlanStateKind = "trial" | "active" | "past_due" | "suspended";

export type PlanQuota = { used: number; allowance: number };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `now` to `date`, rounded up, never below zero. */
export function daysLeft(date: Date | null | undefined, now: Date = new Date()): number | null {
	if (!date) return null;
	return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / DAY_MS));
}

/** The plan's name as the phone shows it. Unknown plans show their id with a capital. */
export function planNameFor(planId: string): string {
	const known: Record<string, string> = {
		personal: "Personal",
		trial: "Trial",
		starter: "Starter",
		pro: "Pro",
		enterprise: "Enterprise",
	};
	return known[planId] ?? planId.charAt(0).toUpperCase() + planId.slice(1);
}

/** Used and left credits and the share used (0 to 100), or null when the plan has no pooled allowance. */
export function quotaView(quota: PlanQuota): { used: number; left: number; percent: number } | null {
	if (quota.allowance <= 0) return null;
	return {
		used: quota.used,
		left: Math.max(0, quota.allowance - quota.used),
		percent: Math.min(100, Math.round((quota.used / quota.allowance) * 100)),
	};
}
