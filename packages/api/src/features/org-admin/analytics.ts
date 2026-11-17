import type { AnalyticsInput, AnalyticsMembersInput } from "./schemas";
import type { AdminActor } from "./service";
import { audit } from "@careeros/billing";
import { ORPCError } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@reactive-resume/schema/applications/data";
import { csvRow } from "./csv";
import { MEMBER_PAGE_SIZE } from "./schemas";
import { requireOrgAdmin } from "./service";

// CAREEROS (P3-T08, phase plan D8): analytics of the current organization. Plain org-scoped SQL under row-level
// security (resume and application are tenant tables); `member` and `session` are not, so every query on them names the
// organization. No query leaves the organization and nothing here is a definer function.
//
// Definitions (Q321): a member is active when one of their sessions in this organization was used in the range
// (`session.updated_at`). Resumes and applications count by `created_at`. Interviews are applications created in the
// range that are now at the interview stage; offers are those at the offer stage or closed as accepted.

const DAY = 86_400_000;
const MAX_DAYS = 366;
const DEFAULT_DAYS = 30;

export type ResolvedRange = { from: string; to: string; fromTs: string; toTs: string };

const day = (date: Date) => date.toISOString().slice(0, 10);

/** The range of a request: dates are UTC days, both ends included. At most 366 days. Defaults to the last 30 days. */
export function resolveRange(input: Pick<AnalyticsInput, "from" | "to">, now = new Date()): ResolvedRange {
	const to = input.to ?? day(now);
	const from = input.from ?? day(new Date(Date.parse(`${to}T00:00:00Z`) - (DEFAULT_DAYS - 1) * DAY));
	const start = Date.parse(`${from}T00:00:00Z`);
	const end = Date.parse(`${to}T00:00:00Z`);
	if (Number.isNaN(start) || Number.isNaN(end) || start > end)
		throw new ORPCError("BAD_REQUEST", { message: "The start of the range must not be after its end." });
	if ((end - start) / DAY + 1 > MAX_DAYS)
		throw new ORPCError("BAD_REQUEST", { message: `The range can cover at most ${MAX_DAYS} days.` });
	return { from, to, fromTs: new Date(start).toISOString(), toTs: new Date(end + DAY).toISOString() };
}

/** The cohort of a filter must be one of this organization's (a foreign id answers 404, like an unknown one). */
async function checkCohort(organizationId: string, cohortId: string | undefined): Promise<void> {
	if (cohortId === undefined) return;
	const [row] = await db
		.select({ id: schema.cohort.id })
		.from(schema.cohort)
		.where(and(eq(schema.cohort.organizationId, organizationId), eq(schema.cohort.id, cohortId)))
		.limit(1);
	if (!row) throw new ORPCError("NOT_FOUND", { message: "Cohort not found." });
}

const cohortFilter = (cohortId: string | undefined) =>
	cohortId === undefined ? sql`` : sql`and m.cohort_id = ${cohortId}`;

type SummaryRow = {
	members: number;
	active: number;
	resumes: number;
	[stage: string]: number;
};

export async function getAnalyticsSummary(userId: string, input: AnalyticsInput) {
	const organizationId = await requireOrgAdmin(userId);
	return summarize(organizationId, input);
}

async function summarize(organizationId: string, input: AnalyticsInput) {
	const range = resolveRange(input);
	await checkCohort(organizationId, input.cohortId);
	const result = await db.execute<SummaryRow>(sql`
		with m as (
			select m.user_id from member m
			where m.organization_id = ${organizationId} ${cohortFilter(input.cohortId)}
		),
		stages as (
			select a.status, a.closed_reason from application a
			where a.organization_id = ${organizationId}
				and a.created_at >= ${range.fromTs}::timestamptz and a.created_at < ${range.toTs}::timestamptz
				and a.user_id in (select user_id from m)
		)
		select
			(select count(*) from m)::int as members,
			(select count(distinct s.user_id) from session s
				where s.active_organization_id = ${organizationId} and s.user_id in (select user_id from m)
					and s.updated_at >= ${range.fromTs}::timestamptz and s.updated_at < ${range.toTs}::timestamptz)::int as active,
			(select count(*) from resume r
				where r.organization_id = ${organizationId} and r.user_id in (select user_id from m)
					and r.created_at >= ${range.fromTs}::timestamptz and r.created_at < ${range.toTs}::timestamptz)::int as resumes,
			(select count(*) from stages)::int as applications,
			(select count(*) from stages where status = 'interview')::int as interviews,
			(select count(*) from stages where status = 'offer' or (status = 'closed' and closed_reason = 'accepted'))::int as offers,
			${sql.join(
				APPLICATION_STATUSES.map(
					(status) =>
						sql`(select count(*) from stages where status = ${status})::int as ${sql.identifier(`stage_${status}`)}`,
				),
				sql`, `,
			)}
	`);
	const row = result.rows[0] as Record<string, number> | undefined;
	if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR");
	return {
		from: range.from,
		to: range.to,
		cohortId: input.cohortId ?? null,
		members: Number(row.members),
		activeMembers: Number(row.active),
		resumesCreated: Number(row.resumes),
		applicationsCreated: Number(row.applications),
		applicationsByStage: Object.fromEntries(
			APPLICATION_STATUSES.map((status) => [status, Number(row[`stage_${status}`])]),
		) as Record<ApplicationStatus, number>,
		interviews: Number(row.interviews),
		offers: Number(row.offers),
		// Null: the period-based AI usage lives on Settings → AI usage (P3-T03), not on a date range (Q328).
		aiCreditsUsed: null as number | null,
	};
}

type MemberRow = {
	member_id: string;
	name: string;
	email: string;
	cohort_id: string | null;
	cohort_name: string | null;
	last_active_at: Date | null;
	resumes: number;
	applications: number;
	interviews: number;
	offers: number;
	total: number;
};

// The sort expressions are fixed text chosen from a list, never built from the request.
const SORT_SQL = {
	name: sql`lower(u.name)`,
	email: sql`lower(u.email)`,
	cohort: sql`lower(c.name)`,
	lastActive: sql`last_active_at`,
	resumes: sql`coalesce(r.n, 0)`,
	applications: sql`coalesce(a.n, 0)`,
	interviews: sql`coalesce(a.interviews, 0)`,
	offers: sql`coalesce(a.offers, 0)`,
} as const;

/** One page of the members table. `limit` 0 is not used; `offset` and `size` page it (exports read every page). */
async function memberRows(
	organizationId: string,
	input: AnalyticsInput & Pick<AnalyticsMembersInput, "sort" | "direction">,
	range: ResolvedRange,
	offset: number,
	size: number,
) {
	const direction = input.direction === "desc" ? sql`desc nulls last` : sql`asc nulls last`;
	const sortExpression = SORT_SQL[input.sort ?? "name"];
	const result = await db.execute<MemberRow>(sql`
		select m.id as member_id, u.name, u.email, c.id as cohort_id, c.name as cohort_name,
			la.last_active_at as last_active_at,
			coalesce(r.n, 0)::int as resumes, coalesce(a.n, 0)::int as applications,
			coalesce(a.interviews, 0)::int as interviews, coalesce(a.offers, 0)::int as offers,
			count(*) over ()::int as total
		from member m
		join "user" u on u.id = m.user_id
		left join cohort c on c.organization_id = m.organization_id and c.id = m.cohort_id
		left join (
			select user_id, max(updated_at) as last_active_at from session
			where active_organization_id = ${organizationId} group by user_id
		) la on la.user_id = m.user_id
		left join (
			select user_id, count(*) as n from resume
			where organization_id = ${organizationId}
				and created_at >= ${range.fromTs}::timestamptz and created_at < ${range.toTs}::timestamptz
			group by user_id
		) r on r.user_id = m.user_id
		left join (
			select user_id, count(*) as n,
				count(*) filter (where status = 'interview') as interviews,
				count(*) filter (where status = 'offer' or (status = 'closed' and closed_reason = 'accepted')) as offers
			from application
			where organization_id = ${organizationId}
				and created_at >= ${range.fromTs}::timestamptz and created_at < ${range.toTs}::timestamptz
			group by user_id
		) a on a.user_id = m.user_id
		where m.organization_id = ${organizationId} ${cohortFilter(input.cohortId)}
		order by ${sortExpression} ${direction}, m.id
		limit ${size} offset ${offset}
	`);
	return result.rows;
}

const toMember = (row: MemberRow) => ({
	memberId: row.member_id,
	name: row.name,
	email: row.email,
	cohortId: row.cohort_id,
	cohortName: row.cohort_name,
	lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : null,
	resumes: Number(row.resumes),
	applications: Number(row.applications),
	interviews: Number(row.interviews),
	offers: Number(row.offers),
});

export async function getAnalyticsMembers(userId: string, input: AnalyticsMembersInput) {
	const organizationId = await requireOrgAdmin(userId);
	const range = resolveRange(input);
	await checkCohort(organizationId, input.cohortId);
	const page = input.page ?? 1;
	const rows = await memberRows(organizationId, input, range, (page - 1) * MEMBER_PAGE_SIZE, MEMBER_PAGE_SIZE);
	return { items: rows.map(toMember), total: Number(rows[0]?.total ?? 0), page, pageSize: MEMBER_PAGE_SIZE };
}

// ---------------------------------------------------------------------------------------------------------------
// CSV export

const EXPORT_BATCH = 500;
const MEMBER_HEADER = ["name", "email", "cohort", "last active", "resumes", "applications", "interviews", "offers"];

async function* memberCsv(
	organizationId: string,
	input: AnalyticsInput,
	range: ResolvedRange,
	counter: { rows: number },
): AsyncGenerator<string> {
	yield csvRow(MEMBER_HEADER);
	for (let offset = 0; ; offset += EXPORT_BATCH) {
		const rows = await memberRows(
			organizationId,
			{ ...input, sort: "name", direction: "asc" },
			range,
			offset,
			EXPORT_BATCH,
		);
		for (const row of rows.map(toMember)) {
			counter.rows++;
			yield csvRow([
				row.name,
				row.email,
				row.cohortName,
				row.lastActiveAt,
				row.resumes,
				row.applications,
				row.interviews,
				row.offers,
			]);
		}
		if (rows.length < EXPORT_BATCH) return;
	}
}

/** Collects a generator into a file one chunk at a time, so the whole text never sits in one string. */
async function toCsvFile(chunks: AsyncGenerator<string>, filename: string): Promise<File> {
	const parts: string[] = [];
	for await (const chunk of chunks) parts.push(chunk);
	return new File(parts, filename, { type: "text/csv;charset=utf-8" });
}

const exportName = (kind: "members" | "summary", range: ResolvedRange) =>
	`analytics-${kind}-${range.from}-to-${range.to}.csv`;

/** The members table for the filters, every row. Writes one audit row: who, the filters, the row count. */
export async function exportAnalyticsMembers(actor: AdminActor, input: AnalyticsInput) {
	const organizationId = await requireOrgAdmin(actor.userId);
	const range = resolveRange(input);
	await checkCohort(organizationId, input.cohortId);
	const filename = exportName("members", range);
	const counter = { rows: 0 };
	const body = await toCsvFile(memberCsv(organizationId, input, range, counter), filename);
	await audit({ actorUserId: actor.userId, ip: actor.ip ?? null }, "analytics.exported", null, {
		kind: "members",
		from: range.from,
		to: range.to,
		cohortId: input.cohortId ?? null,
		rows: counter.rows,
	});
	return { headers: { "content-disposition": `attachment; filename="${filename}"` }, body };
}

/** The summary for the filters as `metric,value` rows. Writes one audit row. */
export async function exportAnalyticsSummary(actor: AdminActor, input: AnalyticsInput) {
	const organizationId = await requireOrgAdmin(actor.userId);
	const range = resolveRange(input);
	const summary = await summarize(organizationId, { ...input, from: range.from, to: range.to });
	const metrics: [string, string | number | null][] = [
		["from", summary.from],
		["to", summary.to],
		["members", summary.members],
		["active members", summary.activeMembers],
		["resumes created", summary.resumesCreated],
		["applications created", summary.applicationsCreated],
		...APPLICATION_STATUSES.map((status): [string, number] => [
			`applications at ${status}`,
			summary.applicationsByStage[status],
		]),
		["interviews", summary.interviews],
		["offers", summary.offers],
		["ai credits used", summary.aiCreditsUsed],
	];
	const filename = exportName("summary", range);
	const body = new File(
		[csvRow(["metric", "value"]), ...metrics.map(([name, value]) => csvRow([name, value]))],
		filename,
		{
			type: "text/csv;charset=utf-8",
		},
	);
	await audit({ actorUserId: actor.userId, ip: actor.ip ?? null }, "analytics.exported", null, {
		kind: "summary",
		from: range.from,
		to: range.to,
		cohortId: input.cohortId ?? null,
		rows: metrics.length,
	});
	return { headers: { "content-disposition": `attachment; filename="${filename}"` }, body };
}
