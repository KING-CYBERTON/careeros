import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

/**
 * CareerOS role rules (P1-T03) the organization plugin's default access control does not cover: only an owner changes
 * member roles (the plugin lets an admin do it). Everything else comes from the plugin: owner and admin can invite and
 * remove, a member cannot, only an owner can grant or remove `owner`, and the last owner cannot be removed or demoted.
 * The actor and the organization come from the session, never from client-supplied ids.
 */
export const organizationRules = {
	id: "careeros-organization-rules",
	hooks: {
		before: [
			{
				matcher: (context) => context.path === "/organization/update-member-role",
				handler: createAuthMiddleware(async (ctx) => {
					const session = await getSessionFromCtx(ctx);
					if (!session) throw APIError.from("UNAUTHORIZED", { code: "UNAUTHORIZED", message: "Sign in first." });
					const body = ctx.body as { organizationId?: unknown } | undefined;
					const organizationId =
						typeof body?.organizationId === "string" && body.organizationId
							? body.organizationId
							: (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
					const [actor] = organizationId
						? await db
								.select({ role: schema.member.role })
								.from(schema.member)
								.where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, session.user.id)))
								.limit(1)
						: [];
					if (!actor?.role.split(",").includes("owner"))
						throw APIError.from("FORBIDDEN", {
							code: "ONLY_OWNERS_CAN_CHANGE_ROLES",
							message: "Only an owner can change member roles.",
						});
				}),
			},
		],
	},
} satisfies BetterAuthPlugin;
