// CAREEROS (P1-T04): row-level security only isolates tenants when the runtime role is neither the owner of the
// tenant tables nor a superuser nor BYPASSRLS. The `owner_access` policy deliberately lets the migration role see every
// organization (security-definer functions rely on it), so a runtime connection using that role would silently turn
// isolation off. This check refuses to start in production in that case.
interface RoleQueryable {
	query(text: string): Promise<{ rows: RoleRow[] }>;
}

type RoleRow = { role: string; is_owner: boolean; rolsuper: boolean; rolbypassrls: boolean };

export type RuntimeRoleReport = { role: string; problems: string[] };

export async function inspectRuntimeRole(queryable: RoleQueryable): Promise<RuntimeRoleReport> {
	const result = await queryable.query(
		`select current_user::text as role,
			exists (select 1 from pg_catalog.pg_tables where schemaname = 'public' and tablename = 'resume' and tableowner = current_user) as is_owner,
			coalesce(r.rolsuper, false) as rolsuper,
			coalesce(r.rolbypassrls, false) as rolbypassrls
		from (select 1) s left join pg_catalog.pg_roles r on r.rolname = current_user`,
	);
	const row = result.rows[0];
	if (!row) return { role: "unknown", problems: ["could not read the runtime role"] };
	const problems: string[] = [];
	if (row.is_owner) problems.push("owns the tenant tables");
	if (row.rolsuper) problems.push("is a superuser");
	if (row.rolbypassrls) problems.push("has BYPASSRLS");
	return { role: row.role, problems };
}

/** Throws in production, warns elsewhere (the unit-test job runs as `postgres`). */
export async function assertRuntimeRoleEnforcesRls(queryable: RoleQueryable, nodeEnv: string | undefined) {
	const { role, problems } = await inspectRuntimeRole(queryable);
	if (problems.length === 0) return;
	const message =
		`Database role "${role}" ${problems.join(" and ")}, so row-level security does not isolate organizations. ` +
		"Set DATABASE_URL to the unprivileged application role (careeros_app) and DATABASE_MIGRATION_URL to the owner role.";
	if (nodeEnv === "production") {
		console.error(message);
		throw new Error(message);
	}
	console.warn(`${message} Continuing because NODE_ENV is not production.`);
}
