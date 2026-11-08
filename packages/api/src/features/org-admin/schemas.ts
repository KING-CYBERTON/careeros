import z from "zod";
import { APPLICATION_STATUSES } from "@reactive-resume/schema/applications/data";
import { INVITE_ROW_STATUSES } from "./bulk-rules";
import { CSV_MAX_BYTES } from "./csv";

// CAREEROS (P3-T08, phase plan D8): inputs and outputs of the Org Admin console. The organization is never a field:
// it is the one the request resolved.

const name = z.string().trim().min(1).max(100);
const description = z.string().trim().max(1000);
const isoDate = z.iso.date();

export const cohortSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	startsOn: z.string().nullable().describe("A calendar date, YYYY-MM-DD."),
	endsOn: z.string().nullable().describe("A calendar date, YYYY-MM-DD."),
	archivedAt: z.date().nullable(),
	memberCount: z.number().int(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export const cohortListInput = z.object({
	includeArchived: z.boolean().optional().describe("Also return archived cohorts. Defaults to false."),
});

const cohortFields = {
	name,
	description: description.nullable().optional(),
	startsOn: isoDate.nullable().optional(),
	endsOn: isoDate.nullable().optional(),
};

export const cohortCreateInput = z.object(cohortFields);
export const cohortUpdateInput = z.object({ id: z.string().min(1).max(64) }).extend({
	name: name.optional(),
	description: cohortFields.description,
	startsOn: cohortFields.startsOn,
	endsOn: cohortFields.endsOn,
});
export const cohortArchiveInput = z.object({
	id: z.string().min(1).max(64),
	archived: z.boolean().optional().describe("True (the default) archives the cohort; false brings it back."),
});

export const MEMBER_PAGE_SIZE = 50;

export const memberListInput = z.object({
	page: z.number().int().min(1).max(10_000).optional().describe("1-based page of 50 members. Defaults to 1."),
	cohortId: z.string().min(1).max(64).optional().describe("Only the members of this cohort."),
});

export const memberRowSchema = z.object({
	memberId: z.string(),
	userId: z.string(),
	name: z.string(),
	email: z.string(),
	role: z.string(),
	cohortId: z.string().nullable(),
	cohortName: z.string().nullable(),
	joinedAt: z.date(),
});

export const memberListSchema = z.object({
	items: z.array(memberRowSchema),
	total: z.number().int(),
	page: z.number().int(),
	pageSize: z.number().int(),
});

export const setCohortInput = z.object({
	memberIds: z.array(z.string().min(1).max(64)).min(1).max(500),
	cohortId: z
		.string()
		.min(1)
		.max(64)
		.nullable()
		.describe("The cohort to move them to, or null to remove them from theirs."),
});
export const setCohortOutput = z.object({ updated: z.number().int() });

export const bulkInviteInput = z.object({
	file: z
		.file()
		.max(CSV_MAX_BYTES, "The file must be 256 KB or smaller.")
		.describe("A UTF-8 CSV with a header row: email (required), role (member or admin) and cohort (a cohort name)."),
});

export const inviteRowSchema = z.object({
	line: z.number().int(),
	email: z.string(),
	role: z.enum(["member", "admin"]).nullable(),
	cohort: z.string().nullable(),
	status: z.enum(INVITE_ROW_STATUSES),
});

const statusCounts = z.record(z.string(), z.number().int());

export const bulkInviteResultSchema = z.object({
	rows: z.array(inviteRowSchema),
	counts: statusCounts,
	seatLimit: z.number().int().nullable(),
	seatsUsed: z.number().int(),
	sent: z.number().int().describe("Invitations sent by this call. Always 0 for a dry run."),
});

const range = {
	from: isoDate.optional().describe("First day of the range (UTC, inclusive). Defaults to 29 days before `to`."),
	to: isoDate.optional().describe("Last day of the range (UTC, inclusive). Defaults to today. At most 366 days."),
	cohortId: z.string().min(1).max(64).optional().describe("Only members of this cohort."),
};

export const analyticsInput = z.object(range);

export const analyticsSummarySchema = z.object({
	from: z.string(),
	to: z.string(),
	cohortId: z.string().nullable(),
	members: z.number().int(),
	activeMembers: z.number().int().describe("Members with a session active in the range."),
	resumesCreated: z.number().int(),
	applicationsCreated: z.number().int(),
	applicationsByStage: z.record(z.enum(APPLICATION_STATUSES), z.number().int()),
	interviews: z.number().int().describe("Applications created in the range that are now at the interview stage."),
	offers: z
		.number()
		.int()
		.describe("Applications created in the range that are at the offer stage or closed as accepted."),
	aiCreditsUsed: z.number().nullable().describe("Null when the organization's AI usage is not metered."),
});

export const MEMBER_SORTS = [
	"name",
	"email",
	"cohort",
	"lastActive",
	"resumes",
	"applications",
	"interviews",
	"offers",
] as const;

export const analyticsMembersInput = z.object({
	...range,
	sort: z.enum(MEMBER_SORTS).optional().describe("Defaults to name."),
	direction: z.enum(["asc", "desc"]).optional().describe("Defaults to asc."),
	page: z.number().int().min(1).max(10_000).optional().describe("1-based page of 50 members. Defaults to 1."),
});

export const analyticsMemberSchema = z.object({
	memberId: z.string(),
	name: z.string(),
	email: z.string(),
	cohortId: z.string().nullable(),
	cohortName: z.string().nullable(),
	lastActiveAt: z.date().nullable(),
	resumes: z.number().int(),
	applications: z.number().int(),
	interviews: z.number().int(),
	offers: z.number().int(),
});

export const analyticsMembersSchema = z.object({
	items: z.array(analyticsMemberSchema),
	total: z.number().int(),
	page: z.number().int(),
	pageSize: z.number().int(),
});

export const exportInput = z.object(range);
export const exportOutput = z.object({
	headers: z.object({ "content-disposition": z.string() }),
	body: z.file(),
});

export type CohortCreateInput = z.infer<typeof cohortCreateInput>;
export type CohortUpdateInput = z.infer<typeof cohortUpdateInput>;
export type AnalyticsInput = z.infer<typeof analyticsInput>;
export type AnalyticsMembersInput = z.infer<typeof analyticsMembersInput>;
