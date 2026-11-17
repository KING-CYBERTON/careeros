import {
	boardListSchema,
	JOB_REMOTE_KINDS,
	JOB_STATUSES,
	REMOTE_PREFERENCES,
	RUN_STATUSES,
	SCHEDULES,
} from "@careeros/job-discovery";
import z from "zod";

// CAREEROS (P4-T03): the input rules live in `@careeros/discovery-form`, so the web and mobile forms validate with the
// same code as the server.
export { sourceCreateSchema, sourceUpdateSchema } from "@careeros/discovery-form";

export const sourceSchema = z.object({
	id: z.string(),
	name: z.string(),
	titles: z.array(z.string()),
	skills: z.array(z.string()),
	keywords: z.array(z.string()),
	locations: z.array(z.string()),
	remote: z.enum(REMOTE_PREFERENCES),
	boards: boardListSchema,
	schedule: z.enum(SCHEDULES),
	nextRunAt: z.date().nullable(),
	lastRunAt: z.date().nullable(),
	lastScheduledRunAt: z.date().nullable(),
	aiTopN: z.number(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export const runErrorSchema = z.object({
	source: z.string().optional(),
	token: z.string().optional(),
	code: z.string(),
	status: z.number().optional(),
	reason: z.string(),
});

export const AI_SKIPPED_REASONS = ["no_platform_ai", "quota_exhausted", "provider_error"] as const;

export const runSummarySchema = z.object({
	runId: z.string(),
	status: z.enum(RUN_STATUSES),
	fetched: z.number(),
	new: z.number(),
	duplicate: z.number(),
	scored: z.number(),
	aiMatched: z.number().describe("The number of model calls the run made; never more than aiPlanned."),
	aiPlanned: z.number().describe("The most model calls the run planned: min(the automation's ai_top_n, the plan cap)."),
	aiSkippedReason: z
		.enum(AI_SKIPPED_REASONS)
		.nullable()
		.describe("Why the AI step did not run or stopped early. The local scores stay."),
	errors: z.array(runErrorSchema),
});

/** A run as the history shows it: the summary plus when and how it started. */
export const runSchema = runSummarySchema.extend({
	jobSourceId: z.string(),
	trigger: z.enum(["manual", "scheduled"]),
	startedAt: z.date(),
	finishedAt: z.date().nullable(),
});

export const jobSchema = z.object({
	id: z.string(),
	jobSourceId: z.string().nullable(),
	source: z.string(),
	externalId: z.string(),
	boardToken: z.string(),
	title: z.string(),
	company: z.string(),
	location: z.string().nullable(),
	remote: z.enum(JOB_REMOTE_KINDS).nullable(),
	url: z.string(),
	postedAt: z.date().nullable(),
	descriptionHtml: z.string(),
	localScore: z.number(),
	aiScore: z.number().nullable(),
	aiSummary: z.string().nullable(),
	status: z.enum(JOB_STATUSES),
	applicationId: z.string().nullable().describe("The tracker application this job became when it was accepted."),
	acceptedAt: z.date().nullable(),
	createdAt: z.date(),
});

/** The review queue row: the job without its description (fetch it with `jobs.get`). */
export const jobSummarySchema = jobSchema.omit({ descriptionHtml: true });

export const acceptResultSchema = z.object({
	job: jobSchema,
	applicationId: z.string().describe("The application in the tracker. The same one when the job was accepted before."),
});

export const jobListInputSchema = z.object({
	status: z.enum(JOB_STATUSES).optional().describe("Only jobs with this status. Omit for every status."),
	jobSourceId: z.string().min(1).optional().describe("Only jobs found by this automation."),
	limit: z.number().int().min(1).max(100).default(50),
	offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});

/** The account export (P4-T02, Q226): automations, runs and found jobs. The tenant column and the owner are left out. */
export const discoveryExportSchema = z.object({
	automations: z.array(sourceSchema),
	runs: z.array(runSchema.omit({ runId: true }).extend({ id: z.string() })),
	jobs: z.array(jobSchema.extend({ firstSeenRunId: z.string().nullable(), updatedAt: z.date() })),
});
