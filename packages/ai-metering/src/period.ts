// CAREEROS (P3-T03, phase plan D5): the quota period. It follows the subscription's current period; an organization
// without one (or whose stored period does not contain now) uses the calendar month in UTC.

export type QuotaPeriod = { start: Date; end: Date; source: "subscription" | "calendar_month" };

/** The calendar month in UTC that contains `now`: `[first of the month, first of the next month)`. */
export function calendarMonthUtc(now: Date): QuotaPeriod {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
	return { start, end, source: "calendar_month" };
}

/** The period usage is summed over: `[start, end)`. */
export function quotaPeriod(
	subscription: { currentPeriodStart: Date | null; currentPeriodEnd: Date | null } | null | undefined,
	now: Date,
): QuotaPeriod {
	const start = subscription?.currentPeriodStart;
	const end = subscription?.currentPeriodEnd;
	if (
		start &&
		end &&
		start.getTime() < end.getTime() &&
		start.getTime() <= now.getTime() &&
		now.getTime() < end.getTime()
	)
		return { start, end, source: "subscription" };
	return calendarMonthUtc(now);
}
