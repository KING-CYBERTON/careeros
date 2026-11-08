import type { DiscoverySchedule } from "./types";

// CAREEROS (P4-T02, GTM-PLAN G3): when a scheduled automation runs next. Pure: no database, no clock of its own.

/** A scheduled run is spread over this long after its period, so sources do not all fire at the same minute. */
export const JITTER_MAX_MS = 30 * 60 * 1000;
/** A run still `running` after this long is marked `failed` by the scheduler's sweep (a restart killed it). */
export const STALE_RUN_MINUTES = 15;

const PERIOD_MS = {
	daily: 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
} as const;

/**
 * The next scheduled run: `from` plus one period (daily 24 hours, weekly 7 days) plus a random delay of up to 30
 * minutes (never the full 30). `null` for `paused`, which clears the schedule. `random` returns a number in [0, 1)
 * and is replaceable so tests can pin the jitter at both ends.
 */
export function nextRunAfter(schedule: DiscoverySchedule, from: Date, random: () => number = Math.random): Date | null {
	if (schedule === "paused") return null;
	const unit = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
	return new Date(from.getTime() + PERIOD_MS[schedule] + Math.floor(unit * JITTER_MAX_MS));
}
