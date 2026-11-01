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

/**
 * Every tenant table (one with an `organization_id` column) must be registered here. The five resume tables are
 * registered by P1-T04. The resume route group's API check is attached by `packages/api` (it needs the router), which
 * runs `runApiIsolationCheck` with this entry's seed.
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
