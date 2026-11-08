import { getQuotaState } from "@careeros/ai-metering";
import { MAX_URL_CHARS } from "@careeros/job-posting";
import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import z from "zod";
import { auth } from "@reactive-resume/auth/config";
import { db } from "@reactive-resume/db/client";
import { organization } from "@reactive-resume/db/schema";
import { protectedProcedure, protectedProcedureWithoutOrg } from "../../context";
import { accountRateLimit, aiRequestRateLimit } from "../../middleware/rate-limit";
import { platformAiAvailable } from "../ai/platform";
import { tidyClippedJob } from "./cleanup";
import { clippedFieldsSchema } from "./fields";
import { clipperService } from "./service";

// CAREEROS (P5-T02): the Job Clipper's own procedures. `whoami` is on the clipper token's allow-list (scope.ts); the
// two token-management procedures are not, so a clipper token can never list or revoke sign-ins through them. A member
// manages their own sign-ins with a normal session. The member id always comes from the authenticated user.
// CAREEROS (P5-T03): `findByUrl` (the duplicate check) and `cleanup` (the optional AI tidy) are on the allow-list too.
// Neither takes an organization or a member from the request: both act for the token's own member in the organization of
// the request host.

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
				// CAREEROS (P5-T03): whether "Tidy with AI" may be offered: the plan includes platform AI and the pool has credits left.
				tidyAvailable: z.boolean(),
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
			// CAREEROS (P5-T03): both checks read this organization only; neither calls a model.
			const tidyAvailable =
				context.organizationId !== undefined &&
				(await platformAiAvailable(context.organizationId)) &&
				!(await getQuotaState(context.organizationId)).blocked;
			return {
				name: context.user.name,
				image: context.user.image ?? null,
				organizationName: org.name,
				expiresAt: context.authentication?.clipper?.expiresAt ?? null,
				tidyAvailable,
			};
		}),

	// CAREEROS (P5-T03): "is this job already in my tracker?". Reads the caller's own applications in the request's
	// organization and answers at most an id and a title.
	findByUrl: protectedProcedure
		.use(accountRateLimit)
		.route({
			...route,
			method: "GET",
			path: "/clipper/find-by-url",
			operationId: "clipperFindByUrl",
			summary: "Find a saved job by its address",
			description:
				"Returns the id and title of the signed-in member's own application whose posting address is the same as the one given (fragment and tracking parameters ignored), in the organization of the request address; null when there is none. Never returns another member's or another organization's application.",
		})
		.input(
			z.object({
				url: z
					.string()
					.trim()
					.min(1)
					.max(MAX_URL_CHARS * 2),
			}),
		)
		.output(z.object({ match: z.object({ id: z.string(), title: z.string() }).nullable() }))
		.handler(async ({ context, input }) => ({
			match: await clipperService.findByUrl({ userId: context.user.id, url: input.url }),
		})),

	// CAREEROS (P5-T03): "Tidy with AI". Metered on the platform provider, never on a member's saved key.
	cleanup: protectedProcedure
		.use(aiRequestRateLimit)
		.route({
			...route,
			method: "POST",
			path: "/clipper/cleanup",
			operationId: "clipperCleanup",
			summary: "Tidy a clipped job with AI",
			description:
				"Sends the clipped fields to the AI included with the organization's plan and returns them tidied, or unchanged when the answer is not valid. The page text is treated as data, never as instructions. Counts against the organization's monthly AI allowance; refused with AI_QUOTA_EXCEEDED when it is used up.",
		})
		.input(clippedFieldsSchema)
		.output(z.object({ tidied: z.boolean(), fields: clippedFieldsSchema }))
		.handler(({ context, input, signal }) => tidyClippedJob({ userId: context.user.id, fields: input, signal })),

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
