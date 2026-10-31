import type { CareerosTestEnv } from "./env";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { getTestEnv } from "./env";

export const APP_ROLE = "careeros_app";

export type TestPools = {
	owner: pg.Pool;
	app: pg.Pool;
	close: () => Promise<void>;
};

/** Opens one pool per connection URL. Reads under test must use `app`; `owner` is for setup only. */
export function createPools(env: CareerosTestEnv = getTestEnv()): TestPools {
	const owner = new pg.Pool({ connectionString: env.ownerUrl });
	const app = new pg.Pool({ connectionString: env.appUrl });
	return {
		owner,
		app,
		close: async () => {
			await Promise.all([owner.end(), app.end()]);
		},
	};
}

export type TestSchema = {
	name: string;
	drop: () => Promise<void>;
};

/** Creates a uniquely named schema (via the owner pool) that `careeros_app` may use, and returns a dropper. */
export async function createTestSchema(owner: pg.Pool, prefix = "careeros_test"): Promise<TestSchema> {
	if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) throw new Error(`Invalid schema prefix "${prefix}".`);
	const name = `${prefix}_${randomBytes(8).toString("hex")}`;
	await owner.query(`CREATE SCHEMA "${name}"`);
	await owner.query(`GRANT USAGE ON SCHEMA "${name}" TO ${APP_ROLE}`);
	await owner.query(
		`ALTER DEFAULT PRIVILEGES IN SCHEMA "${name}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
	);
	return {
		name,
		drop: async () => {
			await owner.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
		},
	};
}

/**
 * Runs `callback` in a transaction on `pool` (use the app pool) with `app.current_org_id` set transaction-locally.
 * Commits on success; rolls back and rethrows if the callback fails.
 */
export async function withOrgContext<T>(
	pool: pg.Pool,
	orgId: string,
	callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
		const result = await callback(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
