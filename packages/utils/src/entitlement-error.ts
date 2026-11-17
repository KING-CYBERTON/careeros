/**
 * CAREEROS (P3-T02): the three refusals the server gives when an organization's plan or status does not allow
 * something. The oRPC procedures answer FORBIDDEN with `data.code` set to one of these; Better Auth's organization
 * endpoints answer with the same value as the error `code`. Web and mobile turn them into readable messages.
 */
export const SEAT_LIMIT_REACHED = "SEAT_LIMIT_REACHED";
export const ORG_SUSPENDED = "ORG_SUSPENDED";
export const FEATURE_NOT_IN_PLAN = "FEATURE_NOT_IN_PLAN";

export type EntitlementErrorCode = typeof SEAT_LIMIT_REACHED | typeof ORG_SUSPENDED | typeof FEATURE_NOT_IN_PLAN;

const CODES: readonly string[] = [SEAT_LIMIT_REACHED, ORG_SUSPENDED, FEATURE_NOT_IN_PLAN];

function asEntitlementCode(value: unknown): EntitlementErrorCode | undefined {
	return typeof value === "string" && CODES.includes(value) ? (value as EntitlementErrorCode) : undefined;
}

/** The entitlement code an error carries (oRPC `data.code`, or the Better Auth error `code`), or undefined. */
export function entitlementErrorCode(error: unknown): EntitlementErrorCode | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const { code, data } = error as { code?: unknown; data?: unknown };
	const own = asEntitlementCode(code);
	if (own) return own;
	if (typeof data !== "object" || data === null) return undefined;
	return asEntitlementCode((data as { code?: unknown }).code);
}
