import type { AllowListEntry, RegistryEntry } from "./registry";
import type { CheckResult } from "./result";
import type pg from "pg";
import { assertNonPrivilegedRole } from "./guard";
import { DEFAULT_SCHEMA, entrySchema, globalTables, pendingTenantTables, tenancyAllowList } from "./registry";
import { toResult } from "./result";

type TenantTableRow = { table_name: string; rls_enabled: boolean; rls_forced: boolean; has_policy: boolean };

/**
 * Finds every table in `schema` with an `organization_id` column and fails if it is unregistered, has RLS disabled,
 * or has no policy. Reads the system catalogs (pg_attribute), which are visible to every role, rather than
 * information_schema.columns, which hides columns the role has no privilege on and would make the check vacuous
 * for `careeros_app` on tables it cannot read.
 */
export async function runCoverageCheck(
	db: pg.Pool,
	registry: readonly RegistryEntry[],
	schema: string = DEFAULT_SCHEMA,
	allowList: readonly AllowListEntry[] = tenancyAllowList,
): Promise<CheckResult & { tenantTables: string[] }> {
	await assertNonPrivilegedRole(db);
	const { rows } = await db.query<TenantTableRow>(
		`SELECT c.relname AS table_name,
		        c.relrowsecurity AS rls_enabled,
		        c.relforcerowsecurity AS rls_forced,
		        EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS has_policy
		   FROM pg_class c
		   JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname = $1
		    AND c.relkind IN ('r', 'p')
		    AND EXISTS (SELECT 1 FROM pg_attribute a
		                 WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped)
		  ORDER BY c.relname`,
		[schema],
	);

	const registered = new Set(registry.filter((e) => entrySchema(e) === schema).map((e) => e.table));
	const allowed = new Set(allowList.filter((e) => (e.schema ?? DEFAULT_SCHEMA) === schema).map((e) => e.table));
	const failures: string[] = [];
	for (const entry of allowList) {
		if (entry.reason.trim() === "")
			failures.push(`${entry.schema ?? DEFAULT_SCHEMA}.${entry.table}: allow-list entry has no reason`);
	}
	for (const table of allowed) {
		if (registered.has(table))
			failures.push(`${schema}.${table}: is both in the isolation registry and on the allow-list`);
	}
	for (const row of rows) {
		const name = `${schema}.${row.table_name}`;
		if (allowed.has(row.table_name)) continue;
		if (!registered.has(row.table_name))
			failures.push(`${name}: has organization_id but is not in the isolation registry`);
		if (!row.rls_enabled) failures.push(`${name}: row level security is not enabled`);
		if (!row.has_policy) failures.push(`${name}: has no row level security policy`);
		if (registered.has(row.table_name) && !row.rls_forced)
			failures.push(`${name}: FORCE ROW LEVEL SECURITY is not set`);
	}
	return {
		...toResult(failures),
		tenantTables: rows.filter((r) => !allowed.has(r.table_name)).map((r) => r.table_name),
	};
}

/**
 * CAREEROS (P1-T09): every ordinary table in `schema` must be classified: in the registry, on the tenancy allow-list,
 * on the global allow-list, or in the pending set. A table nobody decided about fails, which is how a new table
 * without a tenancy decision fails CI. A table that is both registered and pending also fails (the ticket forgot to
 * remove it from the pending set), and every entry needs a reason.
 */
export async function runUnclassifiedTablesCheck(
	db: pg.Pool,
	registry: readonly RegistryEntry[],
	schema: string = DEFAULT_SCHEMA,
	classified: readonly AllowListEntry[] = [...tenancyAllowList, ...globalTables],
	pending: readonly AllowListEntry[] = pendingTenantTables,
): Promise<CheckResult> {
	await assertNonPrivilegedRole(db);
	const { rows } = await db.query<{ table_name: string }>(
		`SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
		[schema],
	);
	const inSchema = (e: { schema?: string | undefined }) => (e.schema ?? DEFAULT_SCHEMA) === schema;
	const registered = new Set(registry.filter(inSchema).map((e) => e.table));
	const global = new Set(classified.filter(inSchema).map((e) => e.table));
	const pendingSet = new Set(pending.filter(inSchema).map((e) => e.table));
	const failures: string[] = [];
	for (const entry of [...classified, ...pending]) {
		if (entry.reason.trim() === "") failures.push(`${schema}.${entry.table}: list entry has no reason`);
	}
	for (const table of pendingSet) {
		if (registered.has(table) || global.has(table))
			failures.push(`${schema}.${table}: is pending but already registered or global; remove it from the pending set`);
	}
	for (const { table_name: table } of rows) {
		if (!registered.has(table) && !global.has(table) && !pendingSet.has(table))
			failures.push(`${schema}.${table}: is not in the isolation registry, the global allow-list or the pending set`);
	}
	return toResult(failures);
}
