import { isOrgHostNotMemberError } from "@reactive-resume/utils/org-host-error";
import { invitationIdFromCallback } from "@/features/auth/invitation";

/** CAREEROS (P2-T03): where a signed-in user who is not a member of this address's organization lands. */
export const ORG_ACCESS_PATH = "/auth/organization-access";

/**
 * CAREEROS (P2-T03a): true when the user is on the way to an invitation, which is the one page that turns a non-member
 * into a member: the accept-invitation page itself, or a page (sign-in, registration, 2FA) whose `callbackURL` returns
 * to it.
 */
function isOnTheWayToInvitation(location: Pick<Location, "pathname" | "search">) {
	if (invitationIdFromCallback(location.pathname)) return true;
	return invitationIdFromCallback(new URLSearchParams(location.search).get("callbackURL") ?? undefined) !== undefined;
}

/**
 * Sends the browser to the join or switch page when an API call says the user is not a member of the organization
 * of the current address. Any call can answer that, so the one place every call passes through handles it. A full
 * navigation drops the queries that failed.
 */
export function handleOrgHostError(
	error: unknown,
	location: Pick<Location, "pathname" | "search" | "assign"> = window.location,
) {
	if (!isOrgHostNotMemberError(error) || location.pathname === ORG_ACCESS_PATH) return;
	// CAREEROS (P2-T03a): an invitee is not a member yet; redirecting here made the invitation unreachable.
	if (isOnTheWayToInvitation(location)) return;
	location.assign(ORG_ACCESS_PATH);
}
