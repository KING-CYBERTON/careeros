import type { OrganizationOptions } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { InvitationEmail } from "@reactive-resume/email/templates/auth";
import { sendEmail } from "@reactive-resume/email/transport";
import { env } from "@reactive-resume/env/server";

/** Invitations stay valid for 7 days (P1-T01). */
export const INVITATION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;

/**
 * Options for the Better Auth organization plugin. Roles are the plugin defaults (`owner`, `admin`, `member`) and the
 * creator becomes `owner`. `cohortId` and `invitedBy` are CareerOS member fields (PRODUCT.md §6.2); the cohort table
 * arrives in Phase 3, so `cohortId` has no foreign key yet.
 */
export const organizationOptions = {
	creatorRole: "owner",
	// Interim rule (phase plan D6); P1-T03 decides where organizations are created.
	allowUserToCreateOrganization: true,
	invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
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
		// The plugin does not know who invited the member; record the inviter once the invitation is accepted.
		afterAcceptInvitation: async ({ invitation, member }) => {
			await db.update(schema.member).set({ invitedBy: invitation.inviterId }).where(eq(schema.member.id, member.id));
		},
	},
	sendInvitationEmail: async ({ id, email, organization, inviter }) => {
		const url = new URL(`/auth/accept-invitation/${encodeURIComponent(id)}`, env.APP_URL).toString();
		await sendEmail({
			to: email,
			subject: `Join ${organization.name} on Reactive Resume`,
			react: createElement(InvitationEmail, {
				url,
				organizationName: organization.name,
				inviterName: inviter.user.name,
			}),
		});
	},
} satisfies OrganizationOptions;
