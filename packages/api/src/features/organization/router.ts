import z from "zod";
import { protectedProcedure } from "../../context";
import { accountRateLimit } from "../../middleware/rate-limit";
import { auditListInput, auditListSchema, entitlementsSchema, myCohortSchema } from "./schemas";
import { getMyCohort, getOrganizationEntitlements, listAuditLog } from "./service";

// CAREEROS (P3-T01): read-only in this task. The write paths (plan, seats, flags) arrive with T04 and T07.

const route = { tags: ["Organization"] };

export const organizationRouter = {
	entitlements: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/organization/entitlements",
			operationId: "getOrganizationEntitlements",
			summary: "Get what the organization is allowed",
			description:
				"Returns the current organization's plan, status, seat limit and use, AI credits, the resolved feature flags and whether it is read-only (suspended). Any member can read it. Requires authentication.",
		})
		.input(z.object({}).optional())
		.output(entitlementsSchema)
		.handler(() => getOrganizationEntitlements()),

	// CAREEROS (P3-T08): any member can read the name of their own cohort (the profile on web and mobile).
	myCohort: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/organization/my-cohort",
			operationId: "getMyOrganizationCohort",
			summary: "Get the caller's own cohort",
			description:
				"Returns the name of the cohort the caller belongs to in the current organization, or null. Any member can read it. Requires authentication.",
		})
		.input(z.object({}).optional())
		.output(myCohortSchema)
		.handler(({ context }) => getMyCohort(context.user.id)),

	audit: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/organization/audit",
			operationId: "listOrganizationAuditLog",
			summary: "List the organization's audit log",
			description:
				"Returns the current organization's audit entries, newest first, a page at a time. Only an owner or admin can read it. Requires authentication.",
		})
		.input(auditListInput)
		.use(accountRateLimit)
		.errors({
			FORBIDDEN: { status: 403, message: "Only an owner or admin of the organization can do this." },
			BAD_REQUEST: { status: 400, message: "The cursor is not valid." },
		})
		.output(auditListSchema)
		.handler(({ context, input }) => listAuditLog(context.user.id, input)),
};
