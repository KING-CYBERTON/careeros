// CAREEROS (P3-T02): readable text for the three refusals the server gives when a plan or status does not allow a call.
// Kept apart from `entitlements.tsx` so the API client can import it without a cycle.
import { t } from "@lingui/core/macro";
import { entitlementErrorCode } from "@reactive-resume/utils/entitlement-error";

/** Readable text for SEAT_LIMIT_REACHED, ORG_SUSPENDED and FEATURE_NOT_IN_PLAN, or undefined for any other error. */
export function entitlementErrorMessage(error: unknown): string | undefined {
	switch (entitlementErrorCode(error)) {
		case "SEAT_LIMIT_REACHED":
			return t`This organization has no free seats. Remove a member or an invitation, or ask the owner to add seats.`;
		case "ORG_SUSPENDED":
			return t`This organization is suspended. You can view and export your data. Contact your administrator.`;
		case "FEATURE_NOT_IN_PLAN":
			return t`This feature is not part of your organization's plan.`;
		default:
			return undefined;
	}
}
