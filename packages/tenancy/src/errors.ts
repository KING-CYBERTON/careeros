export type TenancyErrorCode =
	| "invalid_org"
	| "org_switch_in_scope"
	| "scope_closed"
	| "connect_in_scope"
	| "org_required";

/** Raised when an organization context cannot be established or would be unsafe. Always fail closed. */
export class TenancyError extends Error {
	readonly code: TenancyErrorCode;

	constructor(code: TenancyErrorCode, message?: string) {
		super(message ?? code);
		this.name = "TenancyError";
		this.code = code;
	}
}
