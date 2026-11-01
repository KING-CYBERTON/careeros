import type pg from "pg";
import { randomUUID } from "node:crypto";

/** The caller identity an API under test sees. */
export type OrgSession = { orgId: string };

export type IsolationApi = {
	/** Lists the entry's rows visible to the session. */
	list: (session: OrgSession) => Promise<{ status: number; ids: string[] }>;
	/** Fetches one row by id as the session. Cross-org ids must answer 404. */
	get: (session: OrgSession, id: string) => Promise<{ status: number }>;
};

export type RegistryEntry = {
	table: string;
	/** Defaults to "public". */
	schema?: string;
	/** Name of the primary key column used to look the seeded row up. Defaults to "id". */
	idColumn?: string;
	/** Inserts one row owned by `orgId` using the owner pool (setup only) and returns its id. */
	seed: (orgId: string, db: pg.Pool) => Promise<string>;
	/** Optional API surface; when present the ID-fuzz API check also runs. */
	api?: IsolationApi;
};

/** CAREEROS (P1-T04): the organization row a tenant row points at, created on demand by the owner pool. */
async function ensureOrganization(db: pg.Pool, orgId: string): Promise<void> {
	await db.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1) ON CONFLICT (id) DO NOTHING`, [orgId]);
}

/** A resume (and its owner) in `orgId`, inserted by the owner pool. Returns the ids the child tables reference. */
async function seedResume(orgId: string, db: pg.Pool): Promise<{ userId: string; resumeId: string }> {
	await ensureOrganization(db, orgId);
	const userId = `iso-user-${randomUUID()}`;
	const resumeId = `iso-resume-${randomUUID()}`;
	await db.query(
		`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, 'Isolation user', $1 || '@example.test', $1, $1)`,
		[userId],
	);
	await db.query(
		`INSERT INTO resume (id, name, slug, data, user_id, organization_id) VALUES ($1, 'Isolation resume', 'isolation', '{}', $2, $3)`,
		[resumeId, userId, orgId],
	);
	return { userId, resumeId };
}

/** CAREEROS (P1-T05): a cover letter (and its owner) in `orgId`, inserted by the owner pool. */
async function seedCoverLetter(orgId: string, db: pg.Pool): Promise<{ userId: string; letterId: string }> {
	await ensureOrganization(db, orgId);
	const userId = `iso-user-${randomUUID()}`;
	const letterId = `iso-letter-${randomUUID()}`;
	await db.query(
		`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, 'Isolation user', $1 || '@example.test', $1, $1)`,
		[userId],
	);
	await db.query(
		`INSERT INTO cover_letter (id, name, style, user_id, organization_id) VALUES ($1, 'Isolation letter', '{}', $2, $3)`,
		[letterId, userId, orgId],
	);
	return { userId, letterId };
}

/** CAREEROS (P1-T06): an owner (user) with a pipeline in `orgId`, inserted by the owner pool. */
async function seedPipeline(orgId: string, db: pg.Pool): Promise<{ userId: string }> {
	await ensureOrganization(db, orgId);
	const userId = `iso-user-${randomUUID()}`;
	await db.query(
		`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, 'Isolation user', $1 || '@example.test', $1, $1)`,
		[userId],
	);
	await db.query(`INSERT INTO application_pipeline (organization_id, user_id, revision) VALUES ($1, $2, 7)`, [
		orgId,
		userId,
	]);
	return { userId };
}

/** CAREEROS (P1-T06): a lane (of a fresh pipeline) in `orgId`. */
async function seedLane(orgId: string, db: pg.Pool): Promise<{ userId: string; laneId: string }> {
	const { userId } = await seedPipeline(orgId, db);
	const laneId = `iso-lane-${randomUUID()}`;
	await db.query(
		`INSERT INTO application_lane (id, organization_id, user_id, category, label, color, position) VALUES ($1, $2, $3, 'saved', 'Isolation lane', '#123456', 0)`,
		[laneId, orgId, userId],
	);
	return { userId, laneId };
}

/** CAREEROS (P1-T07): a fresh owner (user) in `orgId`, inserted by the owner pool. */
async function seedUser(orgId: string, db: pg.Pool): Promise<string> {
	await ensureOrganization(db, orgId);
	const userId = `iso-user-${randomUUID()}`;
	await db.query(
		`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, 'Isolation user', $1 || '@example.test', $1, $1)`,
		[userId],
	);
	return userId;
}

/** CAREEROS (P1-T07): an application (and its owner) in `orgId`, for the career tables that point at one. */
async function seedApplication(orgId: string, db: pg.Pool): Promise<{ userId: string; applicationId: string }> {
	const { userId } = await seedPipeline(orgId, db);
	const applicationId = `iso-application-${randomUUID()}`;
	await db.query(
		`INSERT INTO application (id, organization_id, user_id, company, role) VALUES ($1, $2, $3, 'Isolation Co', 'Engineer')`,
		[applicationId, orgId, userId],
	);
	return { userId, applicationId };
}

/** CAREEROS (P1-T07): a discovery schedule (no application) in `orgId`. */
async function seedSchedule(orgId: string, db: pg.Pool): Promise<{ userId: string; scheduleId: string }> {
	const userId = await seedUser(orgId, db);
	const scheduleId = `iso-schedule-${randomUUID()}`;
	await db.query(
		`INSERT INTO career_schedule (id, organization_id, user_id, kind, query, next_run_at) VALUES ($1, $2, $3, 'discovery', 'engineer', now())`,
		[scheduleId, orgId, userId],
	);
	return { userId, scheduleId };
}

/** CAREEROS (P1-T08): a conversation (and its owner) in `orgId`, for the assistant tables that point at one. */
async function seedThread(orgId: string, db: pg.Pool): Promise<{ userId: string; threadId: string }> {
	const userId = await seedUser(orgId, db);
	const threadId = `iso-thread-${randomUUID()}`;
	await db.query(
		`INSERT INTO agent_threads (id, organization_id, user_id, title) VALUES ($1, $2, $3, 'Isolation chat')`,
		[threadId, orgId, userId],
	);
	return { userId, threadId };
}

/** CAREEROS (P1-T08): a saved AI connection (and its owner) in `orgId`. The key columns hold placeholders. */
async function seedProvider(orgId: string, db: pg.Pool): Promise<{ userId: string; providerId: string }> {
	const userId = await seedUser(orgId, db);
	const providerId = `iso-provider-${randomUUID()}`;
	await db.query(
		`INSERT INTO ai_providers (id, organization_id, user_id, label, provider, model, encrypted_api_key, api_key_salt, api_key_hash, api_key_preview)
		 VALUES ($1, $2, $3, 'Isolation provider', 'openai', 'model', 'x', 'x', 'x', 'x')`,
		[providerId, orgId, userId],
	);
	return { userId, providerId };
}

/**
 * Every tenant table (one with an `organization_id` column) must be registered here. The five resume tables are
 * registered by P1-T04, the two cover letter tables by P1-T05 and the four application tables by P1-T06 the eleven career tables by P1-T07 and the six assistant and AI tables by P1-T08. The route
 * groups' API checks are attached by `packages/api` (it needs the router), which runs `runApiIsolationCheck` with this
 * entry's seed.
 */
export const isolationRegistry: readonly RegistryEntry[] = [
	{
		table: "resume",
		seed: async (orgId, db) => (await seedResume(orgId, db)).resumeId,
	},
	{
		table: "resume_version",
		seed: async (orgId, db) => {
			const { userId, resumeId } = await seedResume(orgId, db);
			const id = `iso-version-${randomUUID()}`;
			await db.query(
				`INSERT INTO resume_version (id, resume_id, user_id, data, organization_id) VALUES ($1, $2, $3, '{}', $4)`,
				[id, resumeId, userId, orgId],
			);
			return id;
		},
	},
	{
		table: "resume_slug_redirect",
		seed: async (orgId, db) => {
			const { userId, resumeId } = await seedResume(orgId, db);
			const id = `iso-redirect-${randomUUID()}`;
			await db.query(
				`INSERT INTO resume_slug_redirect (id, slug, resume_id, user_id, expires_at, organization_id) VALUES ($1, 'old', $2, $3, now() + interval '1 day', $4)`,
				[id, resumeId, userId, orgId],
			);
			return id;
		},
	},
	{
		table: "resume_statistics",
		seed: async (orgId, db) => {
			const { resumeId } = await seedResume(orgId, db);
			const id = `iso-stats-${randomUUID()}`;
			await db.query(`INSERT INTO resume_statistics (id, resume_id, organization_id) VALUES ($1, $2, $3)`, [
				id,
				resumeId,
				orgId,
			]);
			return id;
		},
	},
	{
		table: "resume_statistics_daily",
		seed: async (orgId, db) => {
			const { resumeId } = await seedResume(orgId, db);
			const id = `iso-daily-${randomUUID()}`;
			await db.query(
				`INSERT INTO resume_statistics_daily (id, resume_id, date, organization_id) VALUES ($1, $2, current_date, $3)`,
				[id, resumeId, orgId],
			);
			return id;
		},
	},
	{
		table: "cover_letter",
		seed: async (orgId, db) => (await seedCoverLetter(orgId, db)).letterId,
	},
	{
		table: "cover_letter_version",
		seed: async (orgId, db) => {
			const { userId, letterId } = await seedCoverLetter(orgId, db);
			const id = `iso-letter-version-${randomUUID()}`;
			await db.query(
				`INSERT INTO cover_letter_version (id, cover_letter_id, user_id, data, organization_id) VALUES ($1, $2, $3, '{}', $4)`,
				[id, letterId, userId, orgId],
			);
			return id;
		},
	},
	// CAREEROS (P1-T06): the application tables. `application` seeds through the lane trigger, which creates the
	// pipeline and the default lanes of the organization; the pipeline and the profile are keyed by (organization, user),
	// so their id column is `user_id` and every seed uses a fresh user.
	{
		table: "application",
		seed: async (orgId, db) => {
			const { userId } = await seedPipeline(orgId, db);
			const id = `iso-application-${randomUUID()}`;
			await db.query(
				`INSERT INTO application (id, organization_id, user_id, company, role) VALUES ($1, $2, $3, 'Isolation Co', 'Engineer')`,
				[id, orgId, userId],
			);
			return id;
		},
	},
	{
		table: "application_lane",
		seed: async (orgId, db) => (await seedLane(orgId, db)).laneId,
	},
	{
		table: "application_pipeline",
		idColumn: "user_id",
		seed: async (orgId, db) => {
			const { userId } = await seedPipeline(orgId, db);
			// A marker lane the API check looks for in the other organization's view.
			await db.query(
				`INSERT INTO application_lane (id, organization_id, user_id, category, label, color, position, system_key) VALUES ($1, $2, $3, 'saved', 'Isolation lane', '#123456', 0, 'saved')`,
				[`application-lane:${userId}:saved`, orgId, userId],
			);
			return userId;
		},
	},
	{
		table: "application_profile",
		idColumn: "user_id",
		seed: async (orgId, db) => {
			await ensureOrganization(db, orgId);
			const userId = `iso-user-${randomUUID()}`;
			await db.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, 'Isolation user', $1 || '@example.test', $1, $1)`,
				[userId],
			);
			// The revision equals the owner's id, so the API check can tell this row from any other.
			await db.query(
				`INSERT INTO application_profile (organization_id, user_id, data, reviewed_at, revision) VALUES ($1, $2, '{}', now(), $2)`,
				[orgId, userId],
			);
			return userId;
		},
	},
	// CAREEROS (P1-T07): the eleven career tables. The profile is keyed (organization, user), so its id column is
	// `user_id`; the workspace is keyed by `application_id`. Every seed uses a fresh user.
	{
		table: "career_profile",
		idColumn: "user_id",
		seed: async (orgId, db) => {
			const userId = await seedUser(orgId, db);
			await db.query(`INSERT INTO career_profile (organization_id, user_id, data) VALUES ($1, $2, '{}')`, [
				orgId,
				userId,
			]);
			return userId;
		},
	},
	{
		table: "career_fact",
		seed: async (orgId, db) => {
			const userId = await seedUser(orgId, db);
			const id = `iso-fact-${randomUUID()}`;
			await db.query(
				`INSERT INTO career_fact (id, organization_id, user_id, text, category, source, source_key) VALUES ($1, $2, $3, 'Isolation fact', 'skill', '{}', $1)`,
				[id, orgId, userId],
			);
			return id;
		},
	},
	{
		table: "career_story",
		seed: async (orgId, db) => {
			const userId = await seedUser(orgId, db);
			const id = `iso-story-${randomUUID()}`;
			await db.query(`INSERT INTO career_story (id, organization_id, user_id, data) VALUES ($1, $2, $3, '{}')`, [
				id,
				orgId,
				userId,
			]);
			return id;
		},
	},
	{
		table: "career_artifact",
		seed: async (orgId, db) => {
			const userId = await seedUser(orgId, db);
			const id = `iso-artifact-${randomUUID()}`;
			await db.query(
				`INSERT INTO career_artifact (id, organization_id, user_id, title, data, evidence, input_version) VALUES ($1, $2, $3, 'Isolation item', '{}', '{"factIds":[],"storyIds":[]}', 'v1')`,
				[id, orgId, userId],
			);
			return id;
		},
	},
	{
		table: "career_schedule",
		seed: async (orgId, db) => (await seedSchedule(orgId, db)).scheduleId,
	},
	{
		table: "career_job",
		seed: async (orgId, db) => {
			const { userId, scheduleId } = await seedSchedule(orgId, db);
			const id = `iso-job-${randomUUID()}`;
			await db.query(
				`INSERT INTO career_job (id, organization_id, user_id, schedule_id, due_at) VALUES ($1, $2, $3, $4, now())`,
				[id, orgId, userId, scheduleId],
			);
			return id;
		},
	},
	{
		table: "career_notification",
		seed: async (orgId, db) => {
			const userId = await seedUser(orgId, db);
			const id = `iso-notification-${randomUUID()}`;
			await db.query(
				`INSERT INTO career_notification (id, organization_id, user_id, key, notice) VALUES ($1, $2, $3, $1, '{"type":"email-failed"}')`,
				[id, orgId, userId],
			);
			return id;
		},
	},
	{
		table: "career_opportunity",
		seed: async (orgId, db) => {
			const userId = await seedUser(orgId, db);
			const id = `iso-opportunity-${randomUUID()}`;
			await db.query(
				`INSERT INTO career_opportunity (id, organization_id, user_id, url, snippet) VALUES ($1, $2, $3, 'https://example.test/' || $1, 'Isolation role')`,
				[id, orgId, userId],
			);
			return id;
		},
	},
	{
		table: "career_workspace",
		idColumn: "application_id",
		seed: async (orgId, db) => {
			const { userId, applicationId } = await seedApplication(orgId, db);
			await db.query(
				`INSERT INTO career_workspace (application_id, organization_id, user_id, data) VALUES ($1, $2, $3, '{}')`,
				[applicationId, orgId, userId],
			);
			return applicationId;
		},
	},
	{
		table: "career_transcript",
		seed: async (orgId, db) => {
			const userId = await seedUser(orgId, db);
			const id = `iso-transcript-${randomUUID()}`;
			await db.query(
				`INSERT INTO career_transcript (id, organization_id, user_id, original, edited, model) VALUES ($1, $2, $3, 'a', 'a', 'm')`,
				[id, orgId, userId],
			);
			return id;
		},
	},
	{
		table: "career_answer",
		seed: async (orgId, db) => {
			const userId = await seedUser(orgId, db);
			const id = `iso-answer-${randomUUID()}`;
			await db.query(
				`INSERT INTO career_answer (id, organization_id, user_id, question, answer, source, scope, employer, fact_ids, story_ids, evidence, reviewed_at, duplicate_key)
				 VALUES ($1, $2, $3, 'q', 'a', 'manual', 'reusable', '', '[]', '[]', '[]', now(), $1)`,
				[id, orgId, userId],
			);
			return id;
		},
	},
	// CAREEROS (P1-T08): the assistant and AI tables.
	{
		table: "ai_providers",
		seed: async (orgId, db) => (await seedProvider(orgId, db)).providerId,
	},
	{
		table: "agent_threads",
		seed: async (orgId, db) => (await seedThread(orgId, db)).threadId,
	},
	{
		table: "agent_messages",
		seed: async (orgId, db) => {
			const { userId, threadId } = await seedThread(orgId, db);
			const id = `iso-message-${randomUUID()}`;
			await db.query(
				`INSERT INTO agent_messages (id, organization_id, user_id, thread_id, role, sequence, ui_message) VALUES ($1, $2, $3, $4, 'user', 0, '{}')`,
				[id, orgId, userId, threadId],
			);
			return id;
		},
	},
	{
		table: "agent_attachments",
		seed: async (orgId, db) => {
			const { userId, threadId } = await seedThread(orgId, db);
			const id = `iso-attachment-${randomUUID()}`;
			await db.query(
				`INSERT INTO agent_attachments (id, organization_id, user_id, thread_id, storage_key, filename, media_type, size) VALUES ($1, $2, $3, $4, $1, 'isolation.txt', 'text/plain', 1)`,
				[id, orgId, userId, threadId],
			);
			return id;
		},
	},
	{
		table: "agent_actions",
		seed: async (orgId, db) => {
			const { userId, threadId } = await seedThread(orgId, db);
			const id = `iso-action-${randomUUID()}`;
			await db.query(
				`INSERT INTO agent_actions (id, organization_id, user_id, thread_id, kind, title, operations, base_updated_at, applied_updated_at) VALUES ($1, $2, $3, $4, 'resume_patch', 'Isolation edit', '[]', now(), now())`,
				[id, orgId, userId, threadId],
			);
			return id;
		},
	},
	{
		table: "ai_content_report",
		seed: async (orgId, db) => {
			const userId = await seedUser(orgId, db);
			const id = `iso-report-${randomUUID()}`;
			await db.query(
				`INSERT INTO ai_content_report (id, organization_id, user_id, source, reason, content, note) VALUES ($1, $2, $3, 'other', 'other', 'Isolation report', '')`,
				[id, orgId, userId],
			);
			return id;
		},
	},
];

export type AllowListEntry = { table: string; schema?: string; reason: string };

const ORGANIZATION_PLUGIN_REASON =
	"Better Auth organization plugin; defines tenancy; access controlled by Better Auth membership checks (P1-T01)";

/**
 * Tables that carry an `organization_id` column but are not tenant-scoped data (they define tenancy), so they are
 * exempt from the registry, RLS and policy requirements. Every entry needs a reason.
 */
export const tenancyAllowList: readonly AllowListEntry[] = [
	{ table: "organization", reason: ORGANIZATION_PLUGIN_REASON },
	{ table: "member", reason: ORGANIZATION_PLUGIN_REASON },
	{ table: "invitation", reason: ORGANIZATION_PLUGIN_REASON },
	{
		table: "apikey",
		reason:
			"Global auth table by design (phase plan D8): Better Auth reads the key before any organization context exists; the nullable organization_id is checked against membership at use (P1-T02)",
	},
];

export const DEFAULT_SCHEMA = "public";
export const DEFAULT_ID_COLUMN = "id";

export const entrySchema = (entry: RegistryEntry): string => entry.schema ?? DEFAULT_SCHEMA;

export function quoteIdent(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`Invalid SQL identifier "${name}".`);
	return `"${name}"`;
}

export const qualifiedName = (entry: RegistryEntry): string =>
	`${quoteIdent(entrySchema(entry))}.${quoteIdent(entry.table)}`;
