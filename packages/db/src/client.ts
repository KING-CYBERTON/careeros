import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { env } from "@reactive-resume/env/server";
// CAREEROS: relations include the organization plugin tables (P1-T01)
import { authOrganizationRelations } from "./schema/organization";

// CAREEROS: the scope store may hold a single checked-out client (withDatabaseClient) as well as a pool (P1-T02)
/** CAREEROS: lifetime flag of a client scope. After `closed` is true the scope's client belongs to someone else. */
export type DatabaseClientScope = { closed: boolean };

/** CAREEROS: error with a stable `code` raised when a scope's client is used wrongly (P1-T02). */
function scopeError(code: "scope_closed" | "connect_in_scope", message: string) {
	return Object.assign(new Error(message), { name: "TenancyError", code });
}

const assertScopeOpen = (request: { scope?: DatabaseClientScope } | undefined) => {
	if (request?.scope?.closed)
		throw scopeError(
			"scope_closed",
			"The organization scope ended before this database call. Await the work inside withOrgContext.",
		);
};

const createDatabase = (pool: Pool | PoolClient) => drizzle({ client: pool, relations: authOrganizationRelations });
const requestDatabase = new AsyncLocalStorage<{
	pool: Pool | PoolClient;
	database: ReturnType<typeof createDatabase>;
	/** CAREEROS: set for client scopes; `closed` flips before the client is released (P1-T02). */
	scope?: DatabaseClientScope;
}>();

declare global {
	var __pool: Pool | undefined;
	var __drizzle: ReturnType<typeof createDatabase> | undefined;
}

export function getPool() {
	const request = requestDatabase.getStore();
	// CAREEROS: inside withDatabaseClient this is the scoped client, so raw queries share the org context (P1-T02).
	// A closed scope never falls back to the global pool, and the client cannot be re-connected.
	assertScopeOpen(request);
	if (request?.scope) {
		const client = request.pool as PoolClient;
		return new Proxy(client, {
			get(target, property) {
				if (property === "connect") {
					return () => {
						throw scopeError(
							"connect_in_scope",
							"getPool().connect() is not available inside withOrgContext; use the scoped client or run outside the scope.",
						);
					};
				}
				assertScopeOpen(request);
				const value = Reflect.get(target, property, target) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as Pool;
	}
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
export function withDatabaseClient<T>(
	client: PoolClient,
	callback: () => T,
	scope: DatabaseClientScope = { closed: false },
): T {
	return requestDatabase.run({ pool: client, database: createDatabase(client), scope }, callback);
}

/**
 * CAREEROS (P1-T03): runs `callback` outside any `withDatabaseClient` scope, so `db` and `getPool()` use the global
 * pool again. Used by `captureOrgScope` for work that outlives the request that started it. A test pool bound with
 * `withDatabasePool` is left in place.
 */
export function withoutDatabaseScope<T>(callback: () => T): T {
	return requestDatabase.getStore()?.scope ? requestDatabase.exit(callback) : callback();
}

export const db = new Proxy(globalThis.__drizzle, {
	get(target, property) {
		const request = requestDatabase.getStore();
		// CAREEROS: continuations that outlive their organization scope must fail, not use a released client (P1-T02)
		assertScopeOpen(request);
		const database = request?.database ?? target;
		const value = Reflect.get(database, property, database) as unknown;
		return typeof value === "function" ? value.bind(database) : value;
	},
});

/** The client, or a transaction on it: helpers that write take either, so callers choose the transaction. */
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
