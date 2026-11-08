import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import z from "zod";
import { auth } from "@reactive-resume/auth/config";
import { db } from "@reactive-resume/db/client";
import { organization } from "@reactive-resume/db/schema";
import { protectedProcedure, protectedProcedureWithoutOrg } from "../../context";
import { accountRateLimit } from "../../middleware/rate-limit";

// CAREEROS (P5-T02): the Job Clipper's own procedures. `whoami` is on the clipper token's allow-list (scope.ts); the
// two token-management procedures are not, so a clipper token can never list or revoke sign-ins through them. A member
// manages their own sign-ins with a normal session. The member id always comes from the authenticated user.

const route = { tags: ["Job Clipper"] };

const tokenSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	organizationName: z.string(),
	host: z.string(),
	label: z.string(),
	createdAt: z.string(),
	lastUsedAt: z.string().nullable(),
	expiresAt: z.string(),
});

export const clipperRouter = {
	whoami: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/clipper/whoami",
			operationId: "clipperWhoami",
			summary: "Who the Job Clipper is signed in as",
			description:
				"Returns the signed-in member's name and avatar, the name of the organization the request address belongs to, and when the clipper sign-in expires (null for a browser session).",
		})
		.input(z.object({}).optional())
		.output(
			z.object({
				name: z.string(),
				image: z.string().nullable(),
				organizationName: z.string(),
				expiresAt: z.string().nullable(),
			}),
		)
		.handler(async ({ context }) => {
			const [org] = context.organizationId
				? await db
						.select({ name: organization.name })
						.from(organization)
						.where(eq(organization.id, context.organizationId))
						.limit(1)
				: [];
			if (!org) throw new ORPCError("NOT_FOUND", { message: "No organization answers on this address." });
			return {
				name: context.user.name,
				image: context.user.image ?? null,
				organizationName: org.name,
				expiresAt: context.authentication?.clipper?.expiresAt ?? null,
			};
		}),

	listTokens: protectedProcedureWithoutOrg
		.use(accountRateLimit)
		.route({
			...route,
			method: "GET",
			path: "/clipper/tokens",
			operationId: "listClipperTokens",
			summary: "List your Job Clipper sign-ins",
			description:
				"Returns the authenticated member's active Job Clipper sign-ins: organization, when created, when last used and a short device label. Never returns the token.",
		})
		.input(z.object({}).optional())
		.output(z.array(tokenSchema))
		.handler(({ context }) => auth.api.clipperListTokens({ body: { userId: context.user.id } })),

	revokeToken: protectedProcedureWithoutOrg
		.use(accountRateLimit)
		.route({
			...route,
			method: "DELETE",
			path: "/clipper/tokens/{id}",
			operationId: "revokeClipperToken",
			summary: "Revoke a Job Clipper sign-in",
			description:
				"Revokes one of the authenticated member's own Job Clipper sign-ins. It stops working on the next request.",
		})
		.input(z.object({ id: z.string().min(1).max(100) }))
		.output(z.object({ revoked: z.boolean() }))
		.handler(({ context, input }) => auth.api.clipperRevokeToken({ body: { userId: context.user.id, id: input.id } })),
};
