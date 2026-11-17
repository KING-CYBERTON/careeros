import type { RegistryEntry } from "./registry";
import type { TestPools } from "@careeros/testing";
import { describe, expect, it } from "vite-plus/test";
import { runApiIsolationCheck } from "./api-check";
import { runDbIsolationCheck } from "./db-check";
import { entrySchema } from "./registry";

export type SuiteContext = { pools: Pick<TestPools, "owner" | "app">; orgA: string; orgB: string };

export type SuiteRunner = { describe: typeof describe; it: typeof it };

/**
 * Registers one `describe` per registry entry (DB check, plus API check when the entry has `api`).
 * Returns the describe names. `runner` is injectable so the generation itself can be tested.
 */
export function registerIsolationSuite(
	registry: readonly RegistryEntry[],
	getContext: () => SuiteContext,
	runner: SuiteRunner = { describe, it },
): string[] {
	return registry.map((entry) => {
		const name = `tenant isolation: ${entrySchema(entry)}.${entry.table}`;
		runner.describe(name, () => {
			runner.it("hides Org A rows from Org B at the database", async () => {
				const result = await runDbIsolationCheck(entry, getContext());
				expect(result.failures).toEqual([]);
			});
			if (entry.api) {
				runner.it("answers 404 and omits the id for Org B through the API", async () => {
					const { pools, orgA, orgB } = getContext();
					const result = await runApiIsolationCheck(entry, { owner: pools.owner, orgA, orgB });
					expect(result.failures).toEqual([]);
				});
			}
		});
		return name;
	});
}
