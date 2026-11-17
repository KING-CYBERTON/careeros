import { resolveHost } from "@careeros/tenancy";
import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { assertOrganizationAcceptsMember } from "./organization-enforcement";
import { isInvitedSignUp } from "./personal-org";

// CAREEROS (P2-T03, phase plan D6): sign-up on an organization host. `config.ts` calls `guardOrgHostSignUp` before a
// user row is created; `createPersonalOrganization` (personal-org.ts) then joins the host organization.

export const ORG_SIGNUP_CLOSED_MESSAGE =
	"This organization is invite only. Ask its administrator for an invitation, then use the link in the invitation email.";

type NewUser = { id?: string; email: string };
type HookContext = { body?: unknown; request?: Request | undefined } | null | undefined;

/**
 * CAREEROS (P2-T06, Q94): whether the organization lets anyone sign up. The person signing up is not a member, so no
 * organization scope is opened for them: a definer function answers one boolean for the host's organization.
 */
async function hasOpenSignup(organizationId: string): Promise<boolean> {
	const { rows } = await db.execute<{ open: boolean | null }>(
		sql`select careeros_org_open_signup(${organizationId}::text) as open`,
	);
	return rows[0]?.open === true;
}

/**
 * Refuses (`FORBIDDEN`, `ORG_SIGNUP_CLOSED`) a new account on an organization host whose organization is invite only,
 * unless the sign-up carries a pending invitation to that organization for the same email. The host comes from the
 * auth request, never from the body. Without a request (a server-side call) the platform rules apply and nothing is
 * checked here.
 */
export async function guardOrgHostSignUp(user: NewUser, context: HookContext): Promise<void> {
	if (!context?.request) return;
	const host = await resolveHost(context.request);
	if (host.kind !== "org") return;
	if (await hasOpenSignup(host.organizationId)) {
		// CAREEROS (P3-T02): an open-signup join takes a seat, and a suspended organization takes nobody. Refusing here
		// means no account is created for a join that cannot happen.
		await assertOrganizationAcceptsMember(host.organizationId);
		return;
	}
	if (await isInvitedSignUp({ id: user.id ?? "", email: user.email }, context, host.organizationId)) return;
	throw new APIError("FORBIDDEN", { message: ORG_SIGNUP_CLOSED_MESSAGE, code: "ORG_SIGNUP_CLOSED" });
}
