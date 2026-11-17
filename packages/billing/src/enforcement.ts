import type { Entitlements } from "./entitlements";
import { isFeatureKey } from "./features";

// CAREEROS (P3-T02, phase plan D3, D4): the rules every gate applies to `getEntitlements`. Pure: no database, no HTTP,
// no Better Auth. Each caller (oRPC middleware, Better Auth hooks, the host join) turns an `EntitlementError` into
// the error type of its own surface; the `code` values are the ones clients know (`@reactive-resume/utils`).

export type EntitlementErrorCode = "SEAT_LIMIT_REACHED" | "ORG_SUSPENDED" | "FEATURE_NOT_IN_PLAN";

/** Raised when an organization's plan or status does not allow what was asked. */
export class EntitlementError extends Error {
	readonly code: EntitlementErrorCode;
	/** The feature key, for `FEATURE_NOT_IN_PLAN`. */
	readonly feature: string | undefined;

	constructor(code: EntitlementErrorCode, message: string, feature?: string) {
		super(message);
		this.name = "EntitlementError";
		this.code = code;
		this.feature = feature;
	}
}

export const SEAT_LIMIT_MESSAGE =
	"This organization has no free seats. Remove a member or an invitation, or ask the owner to add seats.";
export const SUSPENDED_MESSAGE =
	"This organization is suspended. You can view and export your data. Contact your administrator.";

/**
 * Whether one more member fits. `releasesSeat` is true when the new member comes from a pending invitation that is
 * already counted in `seatsUsed` (accepting it turns the invitation into a member and the total stays the same).
 * A null `seatLimit` means unlimited.
 */
export function hasFreeSeat(
	entitlements: Pick<Entitlements, "seatLimit" | "seatsUsed">,
	releasesSeat = false,
): boolean {
	if (entitlements.seatLimit === null) return true;
	return entitlements.seatsUsed - (releasesSeat ? 1 : 0) + 1 <= entitlements.seatLimit;
}

/** Refuses with `SEAT_LIMIT_REACHED` when no seat is free (see `hasFreeSeat`). */
export function assertSeatAvailable(
	entitlements: Pick<Entitlements, "seatLimit" | "seatsUsed">,
	releasesSeat = false,
): void {
	if (!hasFreeSeat(entitlements, releasesSeat)) throw new EntitlementError("SEAT_LIMIT_REACHED", SEAT_LIMIT_MESSAGE);
}

/** Refuses with `ORG_SUSPENDED` while the organization is read-only. */
export function assertWritable(entitlements: Pick<Entitlements, "readOnly">): void {
	if (entitlements.readOnly) throw new EntitlementError("ORG_SUSPENDED", SUSPENDED_MESSAGE);
}

/**
 * The SQLSTATE the database trigger `careeros_enforce_seat_limit` raises when a member or a pending invitation would
 * pass the seat limit (migration `seat_limit_triggers`). It is the backstop for requests that race the early check.
 */
export const SEAT_LIMIT_SQLSTATE = "CS001";

/** Whether `error`, or a cause behind it (Drizzle wraps driver errors), is the seat-limit trigger refusing. */
export function isSeatLimitDatabaseError(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
		if ((current as { code?: unknown }).code === SEAT_LIMIT_SQLSTATE) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/** The error to raise for a refusal by the seat-limit trigger. */
export function seatLimitError(): EntitlementError {
	return new EntitlementError("SEAT_LIMIT_REACHED", SEAT_LIMIT_MESSAGE);
}

/** Refuses with `FEATURE_NOT_IN_PLAN` unless the resolved feature map has `key` on. An unknown key is off. */
export function assertFeature(entitlements: Pick<Entitlements, "features">, key: string): void {
	if (entitlements.features[key] === true) return;
	const note = isFeatureKey(key) ? "" : " (unknown key)";
	throw new EntitlementError("FEATURE_NOT_IN_PLAN", `This feature is not part of the plan${note}.`, key);
}
