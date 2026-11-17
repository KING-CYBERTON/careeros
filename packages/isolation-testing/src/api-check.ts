import type { RegistryEntry } from "./registry";
import type { CheckResult } from "./result";
import type pg from "pg";
import { qualifiedName } from "./registry";
import { toResult } from "./result";

/** Seeds in Org A, then as Org B: `get` of Org A's id must be 404 (not 403, not 200) and `list` must omit the id. */
export async function runApiIsolationCheck(
	entry: RegistryEntry,
	ctx: { owner: pg.Pool; orgA: string; orgB: string },
): Promise<CheckResult> {
	const { api } = entry;
	if (!api) throw new Error(`${qualifiedName(entry)} has no api to check.`);
	const id = await entry.seed(ctx.orgA, ctx.owner);
	const orgB = { orgId: ctx.orgB };
	const failures: string[] = [];

	const got = await api.get(orgB, id);
	if (got.status !== 404)
		failures.push(`${qualifiedName(entry)}: get of another org's id answered ${got.status} (expected 404)`);
	const listed = await api.list(orgB);
	if (listed.ids.includes(id)) failures.push(`${qualifiedName(entry)}: list as Org B includes Org A's id`);
	return toResult(failures);
}
