import { getUsageSummary } from "@careeros/ai-metering";
import { requireOrgId } from "@careeros/tenancy";
import z from "zod";
import { protectedProcedure } from "../../context";
import { accountRateLimit } from "../../middleware/rate-limit";
import { requireOrganizationAdmin } from "../branding/service";

// CAREEROS (P3-T03): what the organization's members have used of the pooled AI credits this period. Owners and admins
// only. The organization is the request's, never an input.

export const aiUsageSummarySchema = z.object({
	period: z.object({ start: z.date(), end: z.date() }),
	used: z.number().int().describe("Credits used in the period (1 credit is USD 0.01 of platform AI cost)."),
	allowance: z.number().int().describe("The pooled credits of the organization."),
	overageAllowed: z.boolean(),
	byFeature: z.array(z.object({ feature: z.string(), calls: z.number().int(), credits: z.number().int() })),
	byMember: z
		.array(
			z.object({
				userId: z.string().nullable(),
				name: z.string().nullable(),
				calls: z.number().int(),
				credits: z.number().int(),
			}),
		)
		.describe("The 20 members with the most credits."),
	byDay: z.array(z.object({ day: z.string(), calls: z.number().int(), credits: z.number().int() })),
});

export const aiUsageRouter = {
	summary: protectedProcedure
		.route({
			method: "GET",
			path: "/organization/ai-usage",
			tags: ["Organization"],
			operationId: "getOrganizationAiUsage",
			summary: "Get the organization's AI usage for this period",
			description:
				"Returns the credits the organization's members have used of the platform AI allowance in the current period, by feature, by member (the top 20) and by day, with the allowance. Only an owner or admin can read it. Requires authentication.",
		})
		.input(z.object({}).optional())
		.use(accountRateLimit)
		.errors({ FORBIDDEN: { status: 403, message: "Only an owner or admin of the organization can do this." } })
		.output(aiUsageSummarySchema)
		.handler(async ({ context }) => {
			await requireOrganizationAdmin(context.user.id);
			return getUsageSummary(requireOrgId());
		}),
};
