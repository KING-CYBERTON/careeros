import { withOrgContext } from "@careeros/tenancy";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { getQuotaState, type QuotaState } from "./quota";

// CAREEROS (P3-T03): the organization's AI usage for the current period, for its owner and admins. Platform credits
// only: own-key calls cost the organization nothing. Cost in dollars is not part of it (that is the platform's view).

export type AiUsageSummary = {
	period: { start: Date; end: Date };
	used: number;
	allowance: number;
	overageAllowed: boolean;
	byFeature: { feature: string; calls: number; credits: number }[];
	byMember: { userId: string | null; name: string | null; calls: number; credits: number }[];
	byDay: { day: string; calls: number; credits: number }[];
};

export const TOP_MEMBERS = 20;

export function getUsageSummary(orgId: string, now: Date = new Date()): Promise<AiUsageSummary> {
	return withOrgContext(orgId, async () => {
		const quota: QuotaState = await getQuotaState(orgId, now);
		const inPeriod = and(
			eq(schema.aiUsage.organizationId, orgId),
			eq(schema.aiUsage.source, "platform"),
			gte(schema.aiUsage.createdAt, quota.period.start),
			lt(schema.aiUsage.createdAt, quota.period.end),
		);
		const calls = sql<string>`count(*)::bigint`;
		const credits = sql<string>`coalesce(sum(${schema.aiUsage.credits}), 0)::bigint`;

		const byFeature = await db
			.select({ feature: schema.aiUsage.feature, calls, credits })
			.from(schema.aiUsage)
			.where(inPeriod)
			.groupBy(schema.aiUsage.feature)
			.orderBy(desc(credits));
		const byMember = await db
			.select({ userId: schema.aiUsage.userId, name: schema.user.name, calls, credits })
			.from(schema.aiUsage)
			.leftJoin(schema.user, eq(schema.user.id, schema.aiUsage.userId))
			.where(inPeriod)
			.groupBy(schema.aiUsage.userId, schema.user.name)
			.orderBy(desc(credits))
			.limit(TOP_MEMBERS);
		const day = sql<string>`to_char(date_trunc('day', ${schema.aiUsage.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
		const byDay = await db
			.select({ day, calls, credits })
			.from(schema.aiUsage)
			.where(inPeriod)
			.groupBy(day)
			.orderBy(day);

		return {
			period: { start: quota.period.start, end: quota.period.end },
			used: quota.used,
			allowance: quota.allowance,
			overageAllowed: quota.overageAllowed,
			byFeature: byFeature.map((row) => ({ ...row, calls: Number(row.calls), credits: Number(row.credits) })),
			byMember: byMember.map((row) => ({ ...row, calls: Number(row.calls), credits: Number(row.credits) })),
			byDay: byDay.map((row) => ({ ...row, calls: Number(row.calls), credits: Number(row.credits) })),
		};
	});
}
