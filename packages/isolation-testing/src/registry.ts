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

/**
 * Every tenant table (one with an `organization_id` column) must be registered here. The five resume tables are
 * registered by P1-T04, the two cover letter tables by P1-T05 and the four application tables by P1-T06. The route
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
];

/**
 * CAREEROS (P1-T09): tenant tables that later tickets move behind row-level security. Until each merges, its tables
 * are listed here instead of failing the check. Each ticket REMOVES its tables from this list when it registers them
 * (a table that is both registered and pending fails the check).
 */
export const pendingTenantTables: readonly AllowListEntry[] = [
	// TODO(P1-T07): career.
	...[
		"career_profile",
		"career_fact",
		"career_story",
		"career_artifact",
		"career_schedule",
		"career_job",
		"career_notification",
		"career_opportunity",
		"career_workspace",
		"career_transcript",
		"career_answer",
	].map((table) => ({ table, reason: "Pending P1-T07 (career)" })),
	// TODO(P1-T08): agent and AI.
	...["ai_providers", "agent_threads", "agent_messages", "agent_attachments", "agent_actions", "ai_content_report"].map(
		(table) => ({ table, reason: "Pending P1-T08 (agent and AI)" }),
	),
];
