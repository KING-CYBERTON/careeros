import { Pool } from "pg";

// CareerOS (P1-Q07): test-only raw database access for seeding and polling tenant data.
// The application role (careeros_app) is subject to row level security, so with no app.current_org_id
// it sees no tenant rows. Seeding uses the owner role instead, which passes through the owner_access policy.
// Never use this in application code.

/** E2E_SEED_DATABASE_URL, else DATABASE_MIGRATION_URL (owner role in CI), else DATABASE_URL (single-role local setups). */
export function getSeedDatabaseUrl(): string {
	const url = process.env.E2E_SEED_DATABASE_URL || process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
	if (!url)
		throw new Error("E2E_SEED_DATABASE_URL, DATABASE_MIGRATION_URL or DATABASE_URL is required for E2E seeding.");
	return url;
}

export function createSeedPool(): Pool {
	return new Pool({ connectionString: getSeedDatabaseUrl() });
}

/** Opens a seed pool, runs the callback and always ends the pool. */
export async function withSeedPool<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
	const pool = createSeedPool();
	try {
		return await run(pool);
	} finally {
		await pool.end();
	}
}
