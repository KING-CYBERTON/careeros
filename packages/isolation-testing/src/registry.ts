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
	/**
	 * CAREEROS (P2-T01): every organization owns exactly one row of this table from the moment it exists (a trigger
	 * creates it). The check then expects Org B to see no row of ANOTHER organization, not no row at all.
	 * CAREEROS (P3-T01): also for a table whose rows with a NULL organization are global and visible to every organization
	 * on purpose (`feature_flag`); a global row is nobody else's row, so it is not counted.
	 */
	rowPerOrganization?: boolean;
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

/** CAREEROS (P1-T09): a user in `orgId`, inserted by the owner pool. */
async function seedUserIn(orgId: string, db: pg.Pool): Promise<string> {
	await ensureOrganization(db, orgId);
	const userId = `iso-user-${randomUUID()}`;
	await db.query(
		`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, 'Isolation user', $1 || '@example.test', $1, $1)`,
		[userId],
	);
	return userId;
}

/** CAREEROS (P4-T01): a job discovery automation (and its owner) in `orgId`, inserted by the owner pool. */
async function seedJobSource(orgId: string, db: pg.Pool): Promise<{ userId: string; sourceId: string }> {
	const userId = await seedUser(orgId, db);
	const sourceId = `iso-source-${randomUUID()}`;
	await db.query(
		`INSERT INTO job_source (id, organization_id, user_id, name) VALUES ($1, $2, $3, 'Isolation automation')`,
		[sourceId, orgId, userId],
	);
	return { userId, sourceId };
}

/**
 * Every tenant table (one with an `organization_id` column) must be registered here. The five resume tables are
 * registered by P1-T04, the two cover letter tables by P1-T05 and the four application tables by P1-T06, the eleven career tables by P1-T07, the six assistant and AI tables by P1-T08 and
 * the three remaining ones by P1-T09, the two branding ones by P2-T01, the organization domain one by P2-T06, the three job discovery ones by P4-T01 and the cohort one by P3-T08. The route
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
	// CAREEROS (P1-T09): the three remaining tenant tables. custom_domain and web_access_credentials have a composite
	// key and no id column, so they are looked up by user_id (unique within one seeded row).
	{
		table: "custom_domain",
		idColumn: "user_id",
		seed: async (orgId, db) => {
			const userId = await seedUserIn(orgId, db);
			await db.query(
				`INSERT INTO custom_domain (organization_id, user_id, hostname, verification_token) VALUES ($1, $2, $2 || '.example.test', 'token')`,
				[orgId, userId],
			);
			return userId;
		},
	},
	{
		table: "web_access_credentials",
		idColumn: "user_id",
		seed: async (orgId, db) => {
			const userId = await seedUserIn(orgId, db);
			await db.query(
				`INSERT INTO web_access_credentials (organization_id, user_id, provider, encrypted_api_key) VALUES ($1, $2, 'exa', 'x')`,
				[orgId, userId],
			);
			return userId;
		},
	},
	{
		// No foreign key to organization on purpose: erasure work outlives the organization and the account.
		table: "storage_cleanup_job",
		seed: async (orgId, db) => {
			const id = `iso-cleanup-${randomUUID()}`;
			await db.query(
				`INSERT INTO storage_cleanup_job (id, organization_id, owner_id, storage_key) VALUES ($1, $2, $1, 'uploads/' || $1)`,
				[id, orgId],
			);
			return id;
		},
	},
	// CAREEROS (P2-T01): branding and settings, one row per organization (the primary key is the organization id). The
	// organization insert creates the default rows through a trigger, so the seed updates them (or inserts, if the
	// organization already existed without them).
	{
		table: "organization_branding",
		idColumn: "organization_id",
		rowPerOrganization: true,
		seed: async (orgId, db) => {
			await ensureOrganization(db, orgId);
			await db.query(
				`INSERT INTO organization_branding (organization_id, app_name) VALUES ($1, 'Isolation branding')
				 ON CONFLICT (organization_id) DO UPDATE SET app_name = excluded.app_name`,
				[orgId],
			);
			return orgId;
		},
	},
	{
		table: "organization_settings",
		idColumn: "organization_id",
		rowPerOrganization: true,
		seed: async (orgId, db) => {
			await ensureOrganization(db, orgId);
			await db.query(
				`INSERT INTO organization_settings (organization_id, open_signup) VALUES ($1, true)
				 ON CONFLICT (organization_id) DO UPDATE SET open_signup = excluded.open_signup`,
				[orgId],
			);
			return orgId;
		},
	},
	// CAREEROS (P3-T01): the subscription is one row per organization (the primary key is the organization id), created by
	// a trigger with the organization. The seed updates it (or inserts, if the organization already existed without one).
	{
		table: "subscription",
		idColumn: "organization_id",
		rowPerOrganization: true,
		seed: async (orgId, db) => {
			await ensureOrganization(db, orgId);
			await db.query(
				`INSERT INTO subscription (organization_id, plan_id, provider, seats) VALUES ($1, 'personal', 'manual', 3)
				 ON CONFLICT (organization_id) DO UPDATE SET provider = excluded.provider, seats = excluded.seats`,
				[orgId],
			);
			return orgId;
		},
	},
	// CAREEROS (P3-T01): feature flags have a NULL organization for a global flag, which every organization reads. The
	// check counts only rows of ANOTHER organization (`rowPerOrganization`), so global flags are not mistaken for a leak.
	{
		table: "feature_flag",
		rowPerOrganization: true,
		seed: async (orgId, db) => {
			await ensureOrganization(db, orgId);
			const id = `iso-flag-${randomUUID()}`;
			await db.query(
				`INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ($1, $2, 'isolation_probe', true)`,
				[id, orgId],
			);
			return id;
		},
	},
	// CAREEROS (P3-T01): the audit log. Rows with a NULL organization are platform rows that the app role cannot read at
	// all, so only the organization's own rows are ever visible.
	{
		table: "audit_log",
		seed: async (orgId, db) => {
			await ensureOrganization(db, orgId);
			const id = `iso-audit-${randomUUID()}`;
			await db.query(`INSERT INTO audit_log (id, organization_id, action) VALUES ($1, $2, 'isolation.probe')`, [
				id,
				orgId,
			]);
			return id;
		},
	},
	// CAREEROS (P2-T06): organization custom domains. The hostname is unique across all organizations, so a seed gets its own.
	{
		table: "organization_domain",
		seed: async (orgId, db) => {
			await ensureOrganization(db, orgId);
			const id = `iso-domain-${randomUUID()}`;
			await db.query(
				`INSERT INTO organization_domain (id, organization_id, hostname, verification_token) VALUES ($1, $2, $1 || '.example.test', 'token')`,
				[id, orgId],
			);
			return id;
		},
	},
	// CAREEROS (P4-T01): job discovery. A run and a posting both point at an automation of the same owner.
	{
		table: "job_source",
		seed: async (orgId, db) => (await seedJobSource(orgId, db)).sourceId,
	},
	{
		table: "discovery_run",
		seed: async (orgId, db) => {
			const { sourceId } = await seedJobSource(orgId, db);
			const id = `iso-run-${randomUUID()}`;
			await db.query(`INSERT INTO discovery_run (id, organization_id, job_source_id) VALUES ($1, $2, $3)`, [
				id,
				orgId,
				sourceId,
			]);
			return id;
		},
	},
	// CAREEROS (P3-T08): cohorts of an organization (the name is unique per organization, so a seed gets its own).
	{
		table: "cohort",
		seed: async (orgId, db) => {
			await ensureOrganization(db, orgId);
			const id = `iso-cohort-${randomUUID()}`;
			await db.query(`INSERT INTO cohort (id, organization_id, name) VALUES ($1, $2, $1)`, [id, orgId]);
			return id;
		},
	},
	{
		table: "discovered_job",
		seed: async (orgId, db) => {
			const { userId, sourceId } = await seedJobSource(orgId, db);
			const id = `iso-posting-${randomUUID()}`;
			await db.query(
				`INSERT INTO discovered_job (id, organization_id, user_id, job_source_id, source, external_id, board_token, title, company, url, local_score)
				 VALUES ($1, $2, $3, $4, 'greenhouse', $1, 'isolation', 'Isolation role', 'Isolation Co', 'https://example.test/' || $1, 50)`,
				[id, orgId, userId, sourceId],
			);
			return id;
		},
	},
	// CAREEROS (P3-T03): AI usage metering. The app role can read and insert, never change or delete.
	{
		table: "ai_usage",
		seed: async (orgId, db) => {
			await ensureOrganization(db, orgId);
			const id = `iso-aiusage-${randomUUID()}`;
			await db.query(
				`INSERT INTO ai_usage (id, organization_id, source, feature, provider, model) VALUES ($1, $2, 'own_key', 'resume.improve', 'anthropic', 'isolation-probe')`,
				[id, orgId],
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
	{
		table: "auth_handoff",
		reason:
			"P2-T05: pre-authentication, platform-global like Better Auth's verification table (same class: global, no tenant data, no row level security). It carries organization_id only to name the organization a sign-in is for, so it sits on this list, not the globalTables one, which is for tables without that column. It is read and written before any session or organization context exists and holds only hashes and ten-minute rows",
	},
	// CAREEROS (P5-T02): the Job Clipper sign-in. Both are pre-authentication, platform-global tables like auth_handoff:
	// the device code is redeemed and the token verified before any session or organization context exists.
	{
		table: "device_code",
		reason:
			"P5-T02: Better Auth device-authorization plugin table (pre-authentication, platform-global like auth_handoff and the verification table). organization_id only names the organization whose host the code was requested on; ten-minute rows, reached through the plugin's adapter calls, and every use is checked against the request host's organization and the approver's membership",
	},
	{
		table: "clipper_token",
		reason:
			"P5-T02: Job Clipper sign-in tokens (pre-authentication, platform-global like apikey). Holds the SHA-256 of the token, never the token. organization_id is checked against the request host's organization on every use (a token on another organization's host, the platform host or a custom domain of another organization is refused) and the member must still belong to it; reached only through the careeros-clipper plugin's adapter calls",
	},
	// CAREEROS (P3-T04, phase plan D9)
	{
		table: "billing_event",
		reason:
			"P3-T04: the idempotency record of verified payment-provider events, global like a ledger: provider ids and normalized fields only, never card data. It carries organization_id only to name the organization the verified metadata pointed at (not a foreign key), so it sits on this list, not the globalTables one, which is for tables without that column. It has no tenant policy on purpose: the app role has no privilege on it at all and reaches it only through the definer function careeros_record_billing_event; row level security is forced, with a policy for the owner role alone",
	},
	// CAREEROS (P3-T07, phase plan D6)
	{
		table: "announcement",
		reason:
			"P3-T07: GLOBAL by design, a platform-wide banner (title and plain-text body). Its nullable organization_id only narrows who sees it (null = everyone; not a foreign key), so it sits on this list, not the globalTables one, which is for tables without that column. The app role has no privilege on it: platform admins write it through careeros_admin_announcement_save, which checks the actor and audits, and members read what applies to them through careeros_announcements_for_member; row level security is forced, with a policy for the owner role alone",
	},
	{
		table: "impersonation",
		reason:
			"P3-T07: GLOBAL by design, the platform's record of support (impersonation) sessions: ids, a typed reason and a hashed one-time token, never a credential. organization_id names the member's organization (not a foreign key, so the record outlives it), so it sits on this list, not the globalTables one. The app role has no privilege on it: it is reached only through careeros_admin_impersonation_start and the careeros_impersonation_* functions; row level security is forced, with a policy for the owner role alone",
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

const UPSTREAM_AUTH =
	"Global Better Auth / upstream table: users, sessions and credentials exist before any organization";

/**
 * CAREEROS (P1-T09): tables without an `organization_id` column that are global on purpose. Together with the registry,
 * `tenancyAllowList` and `pendingTenantTables`, they must account for EVERY table in `public`
 * (`runUnclassifiedTablesCheck`), so a new table cannot ship without a decision.
 */
export const globalTables: readonly AllowListEntry[] = [
	{ table: "user", reason: UPSTREAM_AUTH },
	{ table: "account", reason: UPSTREAM_AUTH },
	{ table: "session", reason: UPSTREAM_AUTH },
	{ table: "verification", reason: UPSTREAM_AUTH },
	{ table: "passkey", reason: UPSTREAM_AUTH },
	{ table: "two_factor", reason: UPSTREAM_AUTH },
	{ table: "jwks", reason: "Global signing keys of the OAuth/OIDC provider" },
	{ table: "oauth_client", reason: "OAuth provider tables: global, resolved before any organization context exists" },
	{ table: "oauth_client_assertion", reason: "OAuth provider table (see oauth_client)" },
	{ table: "oauth_client_resource", reason: "OAuth provider table (see oauth_client)" },
	{ table: "oauth_resource", reason: "OAuth provider table (see oauth_client)" },
	{ table: "oauth_consent", reason: "OAuth provider table (see oauth_client)" },
	{ table: "oauth_access_token", reason: "OAuth provider table (see oauth_client)" },
	{ table: "oauth_refresh_token", reason: "OAuth provider table (see oauth_client)" },
	{
		table: "released_username",
		reason: "Global username reservations: a username is unique across all organizations",
	},
	{
		table: "plan",
		reason:
			"P3-T01: the catalogue of plans (price, seat limit, AI credits, features). Global like a price list: it has no organization_id, every role may read it, and only the owner role writes it (SELECT-only policy and grants for careeros_app). It holds no tenant data",
	},
	{
		table: "billing_provider_plan",
		reason:
			"P3-T05: the payment provider's plan codes (one per CareerOS plan, interval, currency, seat count and price), created lazily and cached. Global like the price list: it has no organization_id and holds no tenant data, only provider plan codes and prices. The app role has no privilege on it and reaches it only through careeros_billing_provider_plan_get, _put and _by_code (definer functions); row level security is forced, with a policy for the owner role alone",
	},
	{
		table: "email_suppression",
		reason:
			"P6-T02: addresses the email provider reported as hard bounced or complained about, kept as sha256 of the lower-cased address (the address itself is never stored). Global: a bounce is about the address, not an organization, so it has no organization_id and holds no tenant data. The app role has no privilege on it and reaches it only through careeros_email_is_suppressed and careeros_email_suppress (definer functions); row level security is forced, with a policy for the owner role alone",
	},
	{
		table: "announcement_dismissal",
		reason:
			"P3-T07: which member dismissed which platform announcement (a user id and an announcement id). It has no organization_id: a dismissal belongs to the person, whatever organization they act in, and goes with the account (ON DELETE CASCADE). The app role has no privilege on it; careeros_announcement_dismiss is the only writer",
	},
	{
		table: "organization_domain_cf_cleanup",
		reason:
			"P2-T06: Cloudflare custom hostnames of deleted organizations, queued by a trigger and drained by the polling job. It holds an opaque Cloudflare id and a host name, no tenant data, and has no organization_id because the organization is already gone",
	},
];

/**
 * CAREEROS (P1-T09): tenant tables that later tickets move behind row-level security. Until each merges, its tables
 * are listed here instead of failing the check. Each ticket REMOVES its tables from this list when it registers them
 * (a table that is both registered and pending fails the check).
 */
export const pendingTenantTables: readonly AllowListEntry[] = [];
