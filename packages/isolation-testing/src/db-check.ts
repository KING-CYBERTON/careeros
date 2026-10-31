import type { RegistryEntry } from "./registry";
import type { CheckResult } from "./result";
import type { TestPools } from "@careeros/testing";
import { withOrgContext } from "@careeros/testing";
import { assertNonPrivilegedRole } from "./guard";
import { DEFAULT_ID_COLUMN, qualifiedName, quoteIdent } from "./registry";
import { toResult } from "./result";

export type DbCheckContext = {
	/** `owner` is used only to seed; every read under test uses `app`. */
	pools: Pick<TestPools, "owner" | "app">;
	orgA: string;
	orgB: string;
};

/**
 * Seeds one Org A row, then on the app connection verifies: Org B sees 0 rows (all, and by id), Org A sees exactly 1.
 * Throws (does not return a failure) if the app connection is a superuser or has BYPASSRLS.
 */
export async function runDbIsolationCheck(entry: RegistryEntry, ctx: DbCheckContext): Promise<CheckResult> {
	await assertNonPrivilegedRole(ctx.pools.app);
	const table = qualifiedName(entry);
	const idColumn = quoteIdent(entry.idColumn ?? DEFAULT_ID_COLUMN);
	const id = await entry.seed(ctx.orgA, ctx.pools.owner);

	const count = (orgId: string, byId: boolean) =>
		withOrgContext(ctx.pools.app, orgId, async (client) => {
			const { rows } = byId
				? await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${idColumn} = $1`, [id])
				: await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
			return rows[0]?.n ?? 0;
		});

	const failures: string[] = [];
	const bAll = await count(ctx.orgB, false);
	if (bAll !== 0) failures.push(`${table}: Org B can see ${bAll} row(s) when selecting all (expected 0)`);
	const bById = await count(ctx.orgB, true);
	if (bById !== 0) failures.push(`${table}: Org B can read Org A's row by id (expected 0 rows)`);
	const aById = await count(ctx.orgA, true);
	if (aById !== 1) failures.push(`${table}: Org A sees ${aById} row(s) for its own seeded id (expected exactly 1)`);
	return toResult(failures);
}

/** Counts all rows of `entry` visible on the app connection when `app.current_org_id` was never set. */
export async function countRowsWithoutOrg(entry: RegistryEntry, pools: Pick<TestPools, "app">): Promise<number> {
	await assertNonPrivilegedRole(pools.app);
	const { rows } = await pools.app.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${qualifiedName(entry)}`);
	return rows[0]?.n ?? 0;
}
