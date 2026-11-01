/**
 * CAREEROS (P2-T03): on an organization's own address the API answers FORBIDDEN with `data.code` set to this value
 * when the signed-in user is not a member of that organization. Web and mobile show a "join or switch" screen for it.
 */
export const ORG_HOST_NOT_MEMBER = "ORG_HOST_NOT_MEMBER";

/** Whether `error` is the oRPC error for a user who is not a member of the organization of the current address. */
export function isOrgHostNotMemberError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { code, data } = error as { code?: unknown; data?: unknown };
	if (code === ORG_HOST_NOT_MEMBER) return true;
	if (code !== "FORBIDDEN" || typeof data !== "object" || data === null) return false;
	return (data as { code?: unknown }).code === ORG_HOST_NOT_MEMBER;
}
