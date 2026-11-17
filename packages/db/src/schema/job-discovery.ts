import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";
import { application } from "./applications";
import { user } from "./auth";
import { organization } from "./organization";

// CAREEROS (P4-T01, GTM-PLAN G1 to G4): job discovery. A user's automation (`job_source`), each run of it
// (`discovery_run`) and the postings it found (`discovered_job`). All three are tenant tables under row-level security
// (the migration enables it); writers set `organization_id` from `requireOrgId()`.

/** The values below are repeated in `@careeros/job-discovery` (types.ts); the CHECK constraints keep the database honest. */
export const DISCOVERY_BOARD_SOURCES = ["greenhouse", "lever", "lever_eu", "ashby"] as const;
export const DISCOVERY_REMOTE_PREFERENCES = ["any", "remote", "onsite", "hybrid"] as const;
export const DISCOVERY_JOB_REMOTE_KINDS = ["remote", "onsite", "hybrid"] as const;
export const DISCOVERY_SCHEDULES = ["daily", "weekly", "paused"] as const;
export const DISCOVERY_RUN_STATUSES = ["running", "succeeded", "failed", "partial"] as const;
/** CAREEROS (P4-T02): how a run started, and why its AI step did not run (or stopped). */
export const DISCOVERY_RUN_TRIGGERS = ["manual", "scheduled"] as const;
export const DISCOVERY_AI_SKIPPED_REASONS = ["no_platform_ai", "quota_exhausted", "provider_error"] as const;
export const DISCOVERED_JOB_STATUSES = ["new", "accepted", "dismissed"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

export type StoredBoard = { source: (typeof DISCOVERY_BOARD_SOURCES)[number]; token: string };
export type StoredRunError = {
	/** Absent for a failure of the whole run rather than of one board. */
	source?: (typeof DISCOVERY_BOARD_SOURCES)[number];
	token?: string;
	code: string;
	status?: number;
	reason: string;
};

const tenant = () =>
	pg
		.text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" });
const owner = () =>
	pg
		.text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" });

export const jobSource = pg.pgTable(
	"job_source",
	{
		id: pg
			.text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		organizationId: tenant(),
		userId: owner(),
		name: pg.text("name").notNull(),
		titles: pg
			.text("titles")
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		skills: pg
			.text("skills")
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		keywords: pg
			.text("keywords")
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		locations: pg
			.text("locations")
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		remote: pg.text("remote").$type<(typeof DISCOVERY_REMOTE_PREFERENCES)[number]>().notNull().default("any"),
		/** A list of `{ source, token }`; validated by Zod on the way in and by the array-length CHECK. */
		boards: pg
			.jsonb("boards")
			.$type<StoredBoard[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		schedule: pg.text("schedule").$type<(typeof DISCOVERY_SCHEDULES)[number]>().notNull().default("daily"),
		nextRunAt: pg.timestamp("next_run_at", { withTimezone: true }),
		/** Set by manual runs only: the 10-minute limit of `runNow` reads it. */
		lastRunAt: pg.timestamp("last_run_at", { withTimezone: true }),
		/** CAREEROS (P4-T02): set when a scheduled run starts. Separate from `last_run_at`, so a scheduled run never blocks `runNow`. */
		lastScheduledRunAt: pg.timestamp("last_scheduled_run_at", { withTimezone: true }),
		aiTopN: pg.integer("ai_top_n").notNull().default(10),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(t) => [
		// The targets of the composite foreign keys below (the same pattern as P1-T06).
		pg.unique("job_source_organization_id_id_unique").on(t.organizationId, t.id),
		pg.unique("job_source_owner_id_unique").on(t.organizationId, t.userId, t.id),
		pg.index("job_source_org_user_idx").on(t.organizationId, t.userId, t.createdAt),
		pg.index("job_source_due_idx").on(t.schedule, t.nextRunAt),
		pg.check("job_source_name_check", sql`char_length(${t.name}) between 1 and 120`),
		pg.check("job_source_remote_check", sql`${t.remote} in (${list(DISCOVERY_REMOTE_PREFERENCES)})`),
		pg.check("job_source_schedule_check", sql`${t.schedule} in (${list(DISCOVERY_SCHEDULES)})`),
		pg.check("job_source_ai_top_n_check", sql`${t.aiTopN} between 0 and 50`),
		pg.check(
			"job_source_boards_check",
			sql`jsonb_typeof(${t.boards}) = 'array' and jsonb_array_length(${t.boards}) <= 100`,
		),
		pg.check(
			"job_source_lists_check",
			sql`cardinality(${t.titles}) <= 50 and cardinality(${t.skills}) <= 50 and cardinality(${t.keywords}) <= 50 and cardinality(${t.locations}) <= 50`,
		),
	],
);

export const discoveryRun = pg.pgTable(
	"discovery_run",
	{
		id: pg
			.text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		organizationId: tenant(),
		jobSourceId: pg.text("job_source_id").notNull(),
		status: pg.text("status").$type<(typeof DISCOVERY_RUN_STATUSES)[number]>().notNull().default("running"),
		/** CAREEROS (P4-T02) */
		trigger: pg.text("trigger").$type<(typeof DISCOVERY_RUN_TRIGGERS)[number]>().notNull().default("manual"),
		startedAt: pg.timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		finishedAt: pg.timestamp("finished_at", { withTimezone: true }),
		fetched: pg.integer("fetched").notNull().default(0),
		new: pg.integer("new").notNull().default(0),
		duplicate: pg.integer("duplicate").notNull().default(0),
		scored: pg.integer("scored").notNull().default(0),
		/** The number of model calls made by this run; never more than `aiPlanned`. */
		aiMatched: pg.integer("ai_matched").notNull().default(0),
		/** CAREEROS (P4-T02): `min(ai_top_n, plan cap)` for this run, the most calls it may make. */
		aiPlanned: pg.integer("ai_planned").notNull().default(0),
		/** CAREEROS (P4-T02): set when the AI step was skipped or stopped early; the local scores stay. */
		aiSkippedReason: pg.text("ai_skipped_reason").$type<(typeof DISCOVERY_AI_SKIPPED_REASONS)[number]>(),
		/** Per board: source, token, a code, an HTTP status and a short reason. Never a response body. */
		errors: pg
			.jsonb("errors")
			.$type<StoredRunError[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
	},
	(t) => [
		pg.unique("discovery_run_organization_id_id_unique").on(t.organizationId, t.id),
		pg.index("discovery_run_source_started_idx").on(t.organizationId, t.jobSourceId, t.startedAt.desc()),
		pg
			.foreignKey({
				name: "discovery_run_org_job_source_fkey",
				columns: [t.organizationId, t.jobSourceId],
				foreignColumns: [jobSource.organizationId, jobSource.id],
			})
			.onDelete("cascade"),
		pg.check("discovery_run_status_check", sql`${t.status} in (${list(DISCOVERY_RUN_STATUSES)})`),
		pg.check("discovery_run_trigger_check", sql`${t.trigger} in (${list(DISCOVERY_RUN_TRIGGERS)})`),
		pg.check(
			"discovery_run_ai_skipped_reason_check",
			sql`${t.aiSkippedReason} is null or ${t.aiSkippedReason} in (${list(DISCOVERY_AI_SKIPPED_REASONS)})`,
		),
		pg.check("discovery_run_ai_planned_check", sql`${t.aiPlanned} >= 0 and ${t.aiMatched} <= ${t.aiPlanned}`),
		pg.check(
			"discovery_run_counts_check",
			sql`${t.fetched} >= 0 and ${t.new} >= 0 and ${t.duplicate} >= 0 and ${t.scored} >= 0 and ${t.aiMatched} >= 0`,
		),
	],
);

export const discoveredJob = pg.pgTable(
	"discovered_job",
	{
		id: pg
			.text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		organizationId: tenant(),
		userId: owner(),
		/** Cleared (not deleted) when the automation is deleted, so a dismissal outlives it. */
		jobSourceId: pg.text("job_source_id"),
		source: pg.text("source").$type<(typeof DISCOVERY_BOARD_SOURCES)[number]>().notNull(),
		externalId: pg.text("external_id").notNull(),
		boardToken: pg.text("board_token").notNull(),
		title: pg.text("title").notNull(),
		company: pg.text("company").notNull(),
		location: pg.text("location"),
		remote: pg.text("remote").$type<(typeof DISCOVERY_JOB_REMOTE_KINDS)[number]>(),
		/** https only. */
		url: pg.text("url").notNull(),
		postedAt: pg.timestamp("posted_at", { withTimezone: true }),
		/** Sanitized HTML (strict allow-list). */
		descriptionHtml: pg.text("description_html").notNull().default(""),
		localScore: pg.numeric("local_score", { precision: 5, scale: 2, mode: "number" }).notNull(),
		aiScore: pg.numeric("ai_score", { precision: 5, scale: 2, mode: "number" }),
		aiSummary: pg.text("ai_summary"),
		status: pg.text("status").$type<(typeof DISCOVERED_JOB_STATUSES)[number]>().notNull().default("new"),
		firstSeenRunId: pg.text("first_seen_run_id"),
		/** CAREEROS (P4-T02): the tracker application this job became when it was accepted. Cleared if that application is deleted. */
		applicationId: pg.text("application_id"),
		acceptedAt: pg.timestamp("accepted_at", { withTimezone: true }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(t) => [
		// G2: a dismissed or accepted job is a row that stays, and this key is what keeps it from coming back.
		pg.unique("discovered_job_owner_posting_key").on(t.organizationId, t.userId, t.source, t.externalId),
		pg.index("discovered_job_queue_idx").on(t.organizationId, t.userId, t.status, t.localScore.desc()),
		pg
			.foreignKey({
				name: "discovered_job_org_job_source_fkey",
				columns: [t.organizationId, t.userId, t.jobSourceId],
				foreignColumns: [jobSource.organizationId, jobSource.userId, jobSource.id],
			})
			.onDelete("set null"),
		pg
			.foreignKey({
				name: "discovered_job_org_first_run_fkey",
				columns: [t.organizationId, t.firstSeenRunId],
				foreignColumns: [discoveryRun.organizationId, discoveryRun.id],
			})
			.onDelete("set null"),
		pg
			.foreignKey({
				name: "discovered_job_org_application_fkey",
				columns: [t.organizationId, t.applicationId],
				foreignColumns: [application.organizationId, application.id],
			})
			.onDelete("set null"),
		pg.index("discovered_job_application_idx").on(t.organizationId, t.applicationId),
		pg.check("discovered_job_source_check", sql`${t.source} in (${list(DISCOVERY_BOARD_SOURCES)})`),
		pg.check(
			"discovered_job_remote_check",
			sql`${t.remote} is null or ${t.remote} in (${list(DISCOVERY_JOB_REMOTE_KINDS)})`,
		),
		pg.check("discovered_job_status_check", sql`${t.status} in (${list(DISCOVERED_JOB_STATUSES)})`),
		pg.check("discovered_job_url_check", sql`${t.url} like 'https://%'`),
		pg.check(
			"discovered_job_scores_check",
			sql`${t.localScore} between 0 and 100 and (${t.aiScore} is null or ${t.aiScore} between 0 and 100)`,
		),
		pg.check("discovered_job_text_check", sql`char_length(${t.title}) <= 300 and char_length(${t.company}) <= 300`),
	],
);
