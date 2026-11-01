import { isOrgHostNotMemberError } from "@reactive-resume/utils/org-host-error";

/** CAREEROS (P2-T03): where a signed-in user who is not a member of this address's organization lands. */
export const ORG_ACCESS_PATH = "/auth/organization-access";

/**
 * Sends the browser to the join or switch page when an API call says the user is not a member of the organization
 * of the current address. Any call can answer that, so the one place every call passes through handles it. A full
 * navigation drops the queries that failed.
 */
export function handleOrgHostError(error: unknown, location: Pick<Location, "pathname" | "assign"> = window.location) {
	if (!isOrgHostNotMemberError(error) || location.pathname === ORG_ACCESS_PATH) return;
	location.assign(ORG_ACCESS_PATH);
}
