import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { env } from "@reactive-resume/env/server";
// CAREEROS: relations include the organization plugin tables (P1-T01)
import { authOrganizationRelations } from "./schema/organization";

// CAREEROS: the scope store may hold a single checked-out client (withDatabaseClient) as well as a pool (P1-T02)
const createDatabase = (pool: Pool | PoolClient) => drizzle({ client: pool, relations: authOrganizationRelations });
const requestDatabase = new AsyncLocalStorage<{
	pool: Pool | PoolClient;
	database: ReturnType<typeof createDatabase>;
}>();

declare global {
	var __pool: Pool | undefined;
	var __drizzle: ReturnType<typeof createDatabase> | undefined;
}

export function getPool() {
	const request = requestDatabase.getStore();
	// CAREEROS: inside withDatabaseClient this is the scoped client, so raw queries share the org context (P1-T02)
	if (request) return request.pool as Pool;
	if (!globalThis.__pool) {
		const pool = new Pool({
			connectionString: env.DATABASE_URL,
			max: env.DATABASE_POOL_MAX,
			connectionTimeoutMillis: 10_000,
			idleTimeoutMillis: 10_000,
		});
		const logPgError = (error: unknown) => {
			console.error("[db] postgres connection error:", error);
		};
		// A Postgres connection can drop at any time — e.g. a serverless Postgres such as Neon
		// terminating the connection (code 57P01). `pg` surfaces this as an 'error' event, and
		// without a listener node re-throws it as an unhandled 'error' that crashes the process.
		// Idle clients emit on the pool; a client that is connecting or checked out emits on the
		// client itself, so we must listen on both. The pool then discards the dead client and
		// opens a fresh one on the next query.
		pool.on("error", logPgError);
		pool.on("connect", (client) => {
			client.on("error", logPgError);
		});
		globalThis.__pool = pool;
	}
	return globalThis.__pool;
}

// ponytail: two private fns collapsed; getPool() is already a singleton, global cache preserved
globalThis.__drizzle ??= createDatabase(getPool());

/** Workers must create sockets inside a request and cannot reuse them in another request. */
export function withDatabasePool<T>(pool: Pool, callback: () => T): T {
	return requestDatabase.run({ pool, database: createDatabase(pool) }, callback);
}

/**
 * CAREEROS: runs `callback` with the global `db` (including `db.transaction`) and `getPool()` bound to one checked-out
 * client. `@careeros/tenancy` uses it so the session-level `app.current_org_id` setting applies to every query of a
 * scope (P1-T02). The caller owns the client's checkout and release.
 */
export function withDatabaseClient<T>(client: PoolClient, callback: () => T): T {
	return requestDatabase.run({ pool: client, database: createDatabase(client) }, callback);
}

export const db = new Proxy(globalThis.__drizzle, {
	get(target, property) {
		const database = requestDatabase.getStore()?.database ?? target;
		const value = Reflect.get(database, property, database) as unknown;
		return typeof value === "function" ? value.bind(database) : value;
	},
});

/** The client, or a transaction on it: helpers that write take either, so callers choose the transaction. */
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
