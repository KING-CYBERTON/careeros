import { ORPCError } from "@orpc/server";
import z from "zod";
import { protectedProcedureWithoutOrg } from "../../context";
import { accountRateLimit } from "../../middleware/rate-limit";
import { getHostStatus, joinHostOrganization } from "./service";

// CAREEROS (P2-T03). Both procedures work before the caller is a member of the host organization, so they use
// `protectedProcedureWithoutOrg`; the organization is the host's and is never an input.

const route = { tags: ["Organization"] };

const hostStatusSchema = z.object({
	slug: z.string().describe("The slug of the organization this address belongs to."),
	isMember: z.boolean(),
	openSignup: z.boolean().describe("Whether anyone signed in may join this organization."),
});

export const organizationHostRouter = {
	status: protectedProcedureWithoutOrg
		.route({
			...route,
			method: "GET",
			path: "/organization/host",
			operationId: "getOrganizationHostStatus",
			summary: "Get the caller's standing in the organization of this address",
			description:
				"On an organization's own address, returns the organization's slug, whether the caller is a member and whether the organization has open signup. Fails with NOT_FOUND on the platform address. Requires authentication.",
		})
		.input(z.object({}).optional())
		.use(accountRateLimit)
		.errors({ NOT_FOUND: { status: 404, message: "This address does not belong to an organization." } })
		.output(hostStatusSchema)
		.handler(({ context }) => getHostStatus(context.user.id, context.host)),

	join: protectedProcedureWithoutOrg
		.route({
			...route,
			method: "POST",
			path: "/organization/join",
			operationId: "joinOrganizationOfHost",
			summary: "Join the organization of this address",
			description:
				"On an organization's own address, adds the signed-in user to the organization as a member. Allowed only when the organization has open signup and the user is not a member yet. Requires a browser session.",
		})
		.input(z.object({}).optional())
		.use(accountRateLimit)
		.errors({
			NOT_FOUND: { status: 404, message: "This address does not belong to an organization." },
			FORBIDDEN: { status: 403, message: "This organization is invite only." },
			CONFLICT: { status: 409, message: "You are already a member of this organization." },
		})
		.output(z.object({ slug: z.string(), isMember: z.literal(true) }))
		.handler(({ context }) => {
			// Keys and tokens belong to one organization already; joining is something a person does in the browser.
			if (context.authentication?.method !== "session")
				throw new ORPCError("FORBIDDEN", { message: "Join an organization from a web browser." });
			return joinHostOrganization(context.user.id, context.host);
		}),
};
