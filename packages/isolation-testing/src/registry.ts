import type pg from "pg";

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

/** Every tenant table (one with an `organization_id` column) must be registered here. Empty in Phase 0. */
export const isolationRegistry: readonly RegistryEntry[] = [];

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
