import type { OrganizationOptions } from "better-auth/plugins";
import { bustHostCache } from "@careeros/tenancy";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { invitationSubject } from "@reactive-resume/email/subjects";
import { InvitationEmail } from "@reactive-resume/email/templates/auth";
import { sendEmail } from "@reactive-resume/email/transport";
// CAREEROS: branded emails (P2-T04)
import { buildEmailContext } from "./email-brand";
// CAREEROS (P3-T02): seats and suspension are enforced on the server
import { organizationEnforcementHooks } from "./organization-enforcement";

/** Invitations stay valid for 7 days (P1-T01). */
export const INVITATION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;

/**
 * Options for the Better Auth organization plugin. Roles are the plugin defaults (`owner`, `admin`, `member`) and the
 * creator becomes `owner`. `cohortId` and `invitedBy` are CareerOS member fields (PRODUCT.md §6.2); the cohort table
 * arrived in P3-T08 (a composite foreign key onto it).
 */
export const organizationOptions = {
	creatorRole: "owner",
	// Interim rule (phase plan D6); P1-T03 decides where organizations are created.
	allowUserToCreateOrganization: true,
	invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
	// CAREEROS (P3-T08): the plugin allows 100 pending invitations per organization by default, which would stop a bulk
	// upload of up to 500 rows. The seat limit (hooks and trigger) is what bounds invitations; this is only a ceiling.
	invitationLimit: 1000,
	schema: {
		member: {
			additionalFields: {
				cohortId: { type: "string", required: false, input: false },
				// The foreign key to user.id (on delete set null) lives in the database schema. It is not declared here
				// because a second member-to-user reference makes Better Auth's member/user joins ambiguous.
				invitedBy: { type: "string", required: false, input: false },
			},
		},
	},
	organizationHooks: {
		// CAREEROS (P3-T02): seat limit and suspension (create invitation, accept, add member, role change)
		...organizationEnforcementHooks,
		// CAREEROS (P2-T03): the host cache (60 s) must not keep answering to a slug the organization no longer has.
		afterUpdateOrganization: ({ organization }) => {
			if (organization) bustHostCache({ organizationId: organization.id, slug: organization.slug });
			return Promise.resolve();
		},
		// The plugin does not know who invited the member; record the inviter once the invitation is accepted.
		afterAcceptInvitation: async ({ invitation, member }) => {
			await db.update(schema.member).set({ invitedBy: invitation.inviterId }).where(eq(schema.member.id, member.id));
			// CAREEROS (P3-T08): a bulk invitation can name a cohort; the new member joins it. The column is not a Better
			// Auth field, so it is read from the row. The composite key keeps the cohort inside this organization.
			const [named] = await db
				.select({ cohortId: schema.invitation.cohortId })
				.from(schema.invitation)
				.where(eq(schema.invitation.id, invitation.id))
				.limit(1);
			if (named?.cohortId)
				await db.update(schema.member).set({ cohortId: named.cohortId }).where(eq(schema.member.id, member.id));
		},
	},
	// CAREEROS (P2-T04): branded by the inviting organization and linked to its own host when it has one.
	sendInvitationEmail: async ({ id, email, organization, inviter }) => {
		const mail = await buildEmailContext({ source: "invitation", organizationId: organization.id });
		const url = new URL(`/auth/accept-invitation/${encodeURIComponent(id)}`, mail.linkOrigin).toString();
		await sendEmail({
			to: email,
			subject: invitationSubject(organization.name, mail.brand),
			react: createElement(InvitationEmail, {
				url,
				organizationName: organization.name,
				inviterName: inviter.user.name,
				brand: mail.brand,
			}),
			fromName: mail.fromName,
			replyTo: mail.replyTo,
		});
	},
} satisfies OrganizationOptions;
