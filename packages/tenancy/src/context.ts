import type { PoolClient } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { getPool, withDatabaseClient } from "@reactive-resume/db/client";
import { TenancyError } from "./errors";

const ORG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SETTING = "app.current_org_id";

type OrgScope = { orgId: string; client: PoolClient };
const scopes = new AsyncLocalStorage<OrgScope>();

/** The organization of the active `withOrgContext` scope, or `undefined` outside one. */
export function currentOrgId(): string | undefined {
	return scopes.getStore()?.orgId;
}

/**
 * Runs `fn` with one checked-out database client whose session has `app.current_org_id` set, and with the global
 * `db` and `getPool()` bound to that client, so row-level security sees the organization for every query.
 *
 * Fails closed: the client goes back to the pool only after the setting was reset successfully and `fn` succeeded;
 * otherwise it is released with the error so `pg` destroys the connection instead of reusing a stale org context.
 */
export async function withOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
	if (typeof orgId !== "string" || !ORG_ID_PATTERN.test(orgId)) throw new TenancyError("invalid_org");

	const active = scopes.getStore();
	if (active) {
		if (active.orgId !== orgId) throw new TenancyError("org_switch_in_scope");
		return fn();
	}

	const client = await getPool().connect();
	let failure: Error | undefined;
	try {
		await client.query("select set_config($1, $2, false)", [SETTING, orgId]);
		return await scopes.run({ orgId, client }, () => withDatabaseClient(client, fn));
	} catch (error) {
		failure = error instanceof Error ? error : new Error(String(error));
		throw error;
	} finally {
		if (!failure) {
			try {
				await client.query("select set_config($1, '', false)", [SETTING]);
			} catch (error) {
				failure = error instanceof Error ? error : new Error(String(error));
			}
		}
		// A defined argument makes pg destroy the connection (never reused with an unknown org setting).
		client.release(failure);
	}
}
