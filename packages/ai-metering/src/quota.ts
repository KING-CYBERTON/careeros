import { getEntitlements } from "@careeros/billing";
import { withOrgContext } from "@careeros/tenancy";
import { ORPCError } from "@orpc/client";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { quotaPeriod, type QuotaPeriod } from "./period";

// CAREEROS (P3-T03, phase plan D5): the organization's pooled monthly AI credits. Enforced on the server, before a
// platform call. Own-key calls never reach this code.

export type QuotaState = {
	/** Credits used in the period. */
	used: number;
	/** The pooled allowance: credits per seat times the seats (`getEntitlements(...).aiCreditsTotal`). */
	allowance: number;
	overageAllowed: boolean;
	period: QuotaPeriod;
	/** 80% or more of the allowance is used. */
	warning: boolean;
	/** 100% or more of the allowance is used. */
	exceeded: boolean;
	/** The next platform call is refused: the allowance is used up and the organization may not go over. */
	blocked: boolean;
};

/** Pure part of the quota: thresholds from `used` and `allowance`. An allowance of zero is used up from the start. */
export function evaluateQuota(input: {
	used: number;
	allowance: number;
	overageAllowed: boolean;
	period: QuotaPeriod;
}): QuotaState {
	const exceeded = input.used >= input.allowance;
	return {
		...input,
		warning: input.allowance > 0 && input.used * 5 >= input.allowance * 4,
		exceeded,
		blocked: exceeded && !input.overageAllowed,
	};
}

/**
 * Where the organization stands now. Runs in the organization's scope, so row-level security limits the sum to its own
 * rows. The sum is one query on (organization_id, created_at); the entitlements are cached per request by the caller.
 */
export function getQuotaState(orgId: string, now: Date = new Date()): Promise<QuotaState> {
	return withOrgContext(orgId, async () => {
		const entitlements = await getEntitlements(orgId);
		const [subscription] = await db
			.select({
				currentPeriodStart: schema.subscription.currentPeriodStart,
				currentPeriodEnd: schema.subscription.currentPeriodEnd,
			})
			.from(schema.subscription)
			.where(eq(schema.subscription.organizationId, orgId))
			.limit(1);
		const period = quotaPeriod(subscription, now);
		const [row] = await db
			.select({ used: sql<string>`coalesce(sum(${schema.aiUsage.credits}), 0)::bigint` })
			.from(schema.aiUsage)
			.where(
				and(
					eq(schema.aiUsage.organizationId, orgId),
					gte(schema.aiUsage.createdAt, period.start),
					lt(schema.aiUsage.createdAt, period.end),
				),
			);
		return evaluateQuota({
			used: Number(row?.used ?? 0),
			allowance: entitlements.aiCreditsTotal,
			overageAllowed: entitlements.overageAllowed,
			period,
		});
	});
}

export const AI_QUOTA_EXCEEDED = "AI_QUOTA_EXCEEDED";

/** The message the member sees when the pool is used up (web and mobile show it as it is). */
export const AI_QUOTA_EXCEEDED_MESSAGE = "Your organization has used all of this month's AI allowance.";
/** The one-time warning at 80% (web and mobile show it as it is). */
export const AI_QUOTA_WARNING_MESSAGE = "Your organization has used 80% of this month's AI allowance.";

/** Refuses a platform call when the allowance is used up and overage is not allowed. Returns the state otherwise. */
export async function assertWithinQuota(orgId: string, now: Date = new Date()): Promise<QuotaState> {
	const state = await getQuotaState(orgId, now);
	if (state.blocked)
		throw new ORPCError(AI_QUOTA_EXCEEDED, {
			status: 402,
			message: AI_QUOTA_EXCEEDED_MESSAGE,
			data: { used: state.used, allowance: state.allowance },
		});
	return state;
}
