import { t } from "@lingui/core/macro";

// CareerOS (P1-T03): organization roles in Phase 1 are the Better Auth organization plugin defaults.
export type OrganizationRole = "owner" | "admin" | "member";

/** The server enforces every role rule; these helpers only decide what the UI offers. */
export const canManageMembers = (role: string | undefined) => role === "owner" || role === "admin";
export const canChangeRoles = (role: string | undefined) => role === "owner";

export function getRoleLabel(role: string): string {
	switch (role) {
		case "owner":
			return t`Owner`;
		case "admin":
			return t`Admin`;
		case "member":
			return t`Member`;
		default:
			return role;
	}
}
