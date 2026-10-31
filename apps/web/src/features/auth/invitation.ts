// CareerOS (P1-T03): the invitation email links to this page, and sign-in and registration return to it.

export const acceptInvitationPath = (invitationId: string) =>
	`/auth/accept-invitation/${encodeURIComponent(invitationId)}`;

/** The invitation id in a `callbackURL` that points at the accept-invitation page, if it does. */
export function invitationIdFromCallback(callbackURL: string | undefined): string | undefined {
	const match = /^\/auth\/accept-invitation\/([^/?#]+)/.exec(callbackURL ?? "");
	if (!match?.[1]) return undefined;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return undefined;
	}
}
