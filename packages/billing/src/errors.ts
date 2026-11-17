export type BillingErrorCode =
	| "org_not_found"
	| "plan_not_found"
	| "invalid_audit_action"
	| "audit_org_required"
	// CAREEROS (P3-T04)
	| "subscription_not_found"
	| "unknown_plan"
	| "invalid_manual_payment";

/** Raised when entitlements cannot be answered or an audit row would be malformed. */
export class BillingError extends Error {
	readonly code: BillingErrorCode;

	constructor(code: BillingErrorCode, message?: string) {
		super(message ?? code);
		this.name = "BillingError";
		this.code = code;
	}
}
