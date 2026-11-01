import type { IsolationApi, RegistryEntry } from "./index";
import type { TestPools } from "@careeros/testing";
import { randomUUID as generateId } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createOrgIds, createPools, withOrgContext } from "@careeros/testing";
import {
	countRowsWithoutOrg,
	GUARD_MESSAGE,
	isolationRegistry,
	registerIsolationSuite,
	runApiIsolationCheck,
	runCoverageCheck,
	runDbIsolationCheck,
	withThrowawaySchema,
} from "./index";

let pools: TestPools;
const { orgA, orgB } = createOrgIds();

beforeAll(() => {
	pools = createPools();
});

afterAll(async () => {
	await pools.close();
});

const columns = "id text primary key, organization_id text not null, note text";

/** iso_good (RLS + FORCE + policy), iso_leaky (no RLS), iso_unregistered (RLS + policy), iso_nopolicy (RLS, no policy). */
async function createFixtureTables(schema: string): Promise<void> {
	const q = (sql: string) => pools.owner.query(sql);
	await q(`CREATE TABLE "${schema}".iso_good (${columns})`);
	await q(`ALTER TABLE "${schema}".iso_good ENABLE ROW LEVEL SECURITY`);
	await q(`ALTER TABLE "${schema}".iso_good FORCE ROW LEVEL SECURITY`);
	await q(
		`CREATE POLICY tenant_isolation ON "${schema}".iso_good USING (organization_id = current_setting('app.current_org_id', true))`,
	);
	await q(`CREATE TABLE "${schema}".iso_leaky (${columns})`);
	await q(`CREATE TABLE "${schema}".iso_unregistered (${columns})`);
	await q(`ALTER TABLE "${schema}".iso_unregistered ENABLE ROW LEVEL SECURITY`);
	await q(
		`CREATE POLICY tenant_isolation ON "${schema}".iso_unregistered USING (organization_id = current_setting('app.current_org_id', true))`,
	);
	await q(`CREATE TABLE "${schema}".iso_nopolicy (${columns})`);
	await q(`ALTER TABLE "${schema}".iso_nopolicy ENABLE ROW LEVEL SECURITY`);
}

const entryFor = (schema: string, table: string, api?: IsolationApi): RegistryEntry => ({
	table,
	schema,
	...(api ? { api } : {}),
	seed: async (orgId, db) => {
		const id = generateId();
		await db.query(`INSERT INTO "${schema}"."${table}" (id, organization_id, note) VALUES ($1, $2, 'seed')`, [
			id,
			orgId,
		]);
		return id;
	},
});

const withFixture = (fn: (schema: string) => Promise<void>) =>
	withThrowawaySchema(pools.owner, async (schema) => {
		await createFixtureTables(schema);
		await fn(schema);
	});

const ctx = () => ({ pools, orgA, orgB });

describe("superuser guard", () => {
	it("[1] throws when checks run on the owner connection", async () => {
		await withFixture(async (schema) => {
			const entry = entryFor(schema, "iso_good");
			await expect(
				runDbIsolationCheck(entry, { ...ctx(), pools: { owner: pools.owner, app: pools.owner } }),
			).rejects.toThrow(GUARD_MESSAGE);
			await expect(runCoverageCheck(pools.owner, [entry], schema)).rejects.toThrow(GUARD_MESSAGE);
			await expect(countRowsWithoutOrg(entry, { app: pools.owner })).rejects.toThrow(GUARD_MESSAGE);
		});
	});
});

describe("iso_good", () => {
	it("[2][3][4] hides Org A's row from Org B (all and by id) and shows it to Org A", async () => {
		await withFixture(async (schema) => {
			const result = await runDbIsolationCheck(entryFor(schema, "iso_good"), ctx());
			expect(result).toEqual({ ok: true, failures: [] });
		});
	});

	it("[2][3][4] checks each condition separately", async () => {
		await withFixture(async (schema) => {
			const entry = entryFor(schema, "iso_good");
			const id = await entry.seed(orgA, pools.owner);
			const read = (org: string, where = "") =>
				withOrgContext(pools.app, org, async (c) => {
					const { rows } = await c.query(`SELECT id FROM "${schema}".iso_good ${where}`, where ? [id] : []);
					return rows.length;
				});
			expect(await read(orgB)).toBe(0);
			expect(await read(orgB, "WHERE id = $1")).toBe(0);
			expect(await read(orgA)).toBe(1);
		});
	});

	it("[5] returns 0 rows when no org is set, including on a connection reused after an org context", async () => {
		await withFixture(async (schema) => {
			const entry = entryFor(schema, "iso_good");
			await entry.seed(orgA, pools.owner);
			expect(await countRowsWithoutOrg(entry, pools)).toBe(0);
			await withOrgContext(pools.app, orgA, async () => undefined);
			expect(await countRowsWithoutOrg(entry, pools)).toBe(0);
		});
	});
});

describe("iso_leaky (no RLS)", () => {
	it("[6] DB check reports failure", async () => {
		await withFixture(async (schema) => {
			const result = await runDbIsolationCheck(entryFor(schema, "iso_leaky"), ctx());
			expect(result.ok).toBe(false);
			expect(result.failures.some((f) => /Org B can see 1 row/.test(f))).toBe(true);
			expect(result.failures.some((f) => /by id/.test(f))).toBe(true);
		});
	});

	it("[7] coverage check reports RLS disabled", async () => {
		await withFixture(async (schema) => {
			const registry = [entryFor(schema, "iso_good"), entryFor(schema, "iso_leaky")];
			const result = await runCoverageCheck(pools.app, registry, schema);
			expect(result.ok).toBe(false);
			expect(result.failures).toContain(`${schema}.iso_leaky: row level security is not enabled`);
		});
	});
});

describe("coverage check", () => {
	it("[8] reports an unregistered table", async () => {
		await withFixture(async (schema) => {
			const registry = [entryFor(schema, "iso_good"), entryFor(schema, "iso_leaky"), entryFor(schema, "iso_nopolicy")];
			const result = await runCoverageCheck(pools.app, registry, schema);
			expect(result.ok).toBe(false);
			expect(result.failures).toContain(
				`${schema}.iso_unregistered: has organization_id but is not in the isolation registry`,
			);
		});
	});

	it("[9] reports RLS enabled without a policy", async () => {
		await withFixture(async (schema) => {
			const registry = [entryFor(schema, "iso_good"), entryFor(schema, "iso_nopolicy")];
			const result = await runCoverageCheck(pools.app, registry, schema);
			expect(result.ok).toBe(false);
			expect(result.failures).toContain(`${schema}.iso_nopolicy: has no row level security policy`);
			expect(
				result.failures.some((f) => f.startsWith(`${schema}.iso_nopolicy: row level security is not enabled`)),
			).toBe(false);
		});
	});

	it("passes for an allow-listed table without RLS, and ignores it as unregistered", async () => {
		await withFixture(async (schema) => {
			const registry = [entryFor(schema, "iso_good"), entryFor(schema, "iso_nopolicy"), entryFor(schema, "iso_leaky")];
			const allow = [{ table: "iso_unregistered", schema, reason: "fixture" }];
			const result = await runCoverageCheck(pools.app, registry, schema, allow);
			expect(result.failures.filter((f) => f.includes("iso_unregistered"))).toEqual([]);
		});
	});

	it("fails a table that is both registered and allow-listed", async () => {
		await withFixture(async (schema) => {
			const registry = [entryFor(schema, "iso_good")];
			const allow = [{ table: "iso_good", schema, reason: "fixture" }];
			const result = await runCoverageCheck(pools.app, registry, schema, allow);
			expect(result.failures).toContain(`${schema}.iso_good: is both in the isolation registry and on the allow-list`);
		});
	});

	it("fails an allow-list entry with an empty reason", async () => {
		await withFixture(async (schema) => {
			const allow = [{ table: "iso_leaky", schema, reason: " " }];
			const result = await runCoverageCheck(pools.app, [entryFor(schema, "iso_good")], schema, allow);
			expect(result.failures).toContain(`${schema}.iso_leaky: allow-list entry has no reason`);
		});
	});

	it("fails a registered table with RLS enabled but not forced", async () => {
		await withFixture(async (schema) => {
			const result = await runCoverageCheck(
				pools.app,
				[entryFor(schema, "iso_good"), entryFor(schema, "iso_nopolicy")],
				schema,
				[],
			);
			expect(result.failures).toContain(`${schema}.iso_nopolicy: FORCE ROW LEVEL SECURITY is not set`);
			expect(result.failures.some((f) => f.startsWith(`${schema}.iso_good:`))).toBe(false);
		});
	});

	it("passes when every tenant table is registered, protected and has a policy", async () => {
		await withThrowawaySchema(pools.owner, async (schema) => {
			await pools.owner.query(`CREATE TABLE "${schema}".iso_good (${columns})`);
			await pools.owner.query(`ALTER TABLE "${schema}".iso_good ENABLE ROW LEVEL SECURITY`);
			await pools.owner.query(`ALTER TABLE "${schema}".iso_good FORCE ROW LEVEL SECURITY`);
			await pools.owner.query(
				`CREATE POLICY p ON "${schema}".iso_good USING (organization_id = current_setting('app.current_org_id', true))`,
			);
			await pools.owner.query(`CREATE TABLE "${schema}".plain (id text)`);
			const result = await runCoverageCheck(pools.app, [entryFor(schema, "iso_good")], schema);
			expect(result).toEqual({ ok: true, failures: [], tenantTables: ["iso_good"] });
		});
	});

	it("[14] passes against the real public schema after migrations", async () => {
		const { rows } = await pools.owner.query(
			"SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user'",
		);
		expect(rows.length, "upstream migrations must have run (pnpm db:migrate)").toBe(1);
		const result = await runCoverageCheck(pools.app, isolationRegistry);
		expect(result.failures).toEqual([]);
		expect(result.ok).toBe(true);
		// CAREEROS (P1-T04, P1-T05): the resume, cover letter (P1-T05) and application (P1-T06) tables are the tenant tables so far.
		expect(result.tenantTables.sort()).toEqual(isolationRegistry.map((entry) => entry.table).sort());
	});

	it("registers the resume (P1-T04), cover letter (P1-T05) application (P1-T06) career (P1-T07) and assistant and AI (P1-T08) tables; later batches add theirs", () => {
		expect(isolationRegistry.map((entry) => entry.table)).toEqual([
			"resume",
			"resume_version",
			"resume_slug_redirect",
			"resume_statistics",
			"resume_statistics_daily",
			"cover_letter",
			"cover_letter_version",
			"application",
			"application_lane",
			"application_pipeline",
			"application_profile",
			"career_profile",
			"career_fact",
			"career_story",
			"career_artifact",
			"career_schedule",
			"career_job",
			"career_notification",
			"career_opportunity",
			"career_workspace",
			"career_transcript",
			"career_answer",
			"ai_providers",
			"agent_threads",
			"agent_messages",
			"agent_attachments",
			"agent_actions",
			"ai_content_report",
			"custom_domain",
			"web_access_credentials",
			"storage_cleanup_job",
		]);
	});
});

const fakeApi = (mode: "leaky" | "correct" | "forbidden", rows: Map<string, string>): IsolationApi => ({
	get: async (session, id) => {
		const owner = rows.get(id);
		if (owner === undefined) return { status: 404 };
		if (mode === "leaky") return { status: 200 };
		return { status: owner === session.orgId ? 200 : mode === "forbidden" ? 403 : 404 };
	},
	list: async (session) => ({
		status: 200,
		ids: [...rows].filter(([, o]) => mode === "leaky" || o === session.orgId).map(([id]) => id),
	}),
});

describe("API check", () => {
	const run = async (mode: "leaky" | "correct" | "forbidden") => {
		const rows = new Map<string, string>();
		const base = entryFor("unused", "unused");
		const entry: RegistryEntry = {
			...base,
			api: fakeApi(mode, rows),
			seed: async (orgId) => {
				const id = generateId();
				rows.set(id, orgId);
				return id;
			},
		};
		return runApiIsolationCheck(entry, { owner: pools.owner, orgA, orgB });
	};

	it("[10] fails for an API that returns the row to any org", async () => {
		const result = await run("leaky");
		expect(result.ok).toBe(false);
		expect(result.failures).toHaveLength(2);
	});

	it("[11] passes for an API that answers 404 and omits the id", async () => {
		expect(await run("correct")).toEqual({ ok: true, failures: [] });
	});

	it("[12] fails for an API that answers 403 instead of 404", async () => {
		const result = await run("forbidden");
		expect(result.ok).toBe(false);
		expect(result.failures).toEqual([expect.stringContaining("answered 403 (expected 404)")]);
	});

	it("throws when the entry has no api", async () => {
		await expect(runApiIsolationCheck(entryFor("s", "t"), { owner: pools.owner, orgA, orgB })).rejects.toThrow(
			/no api/,
		);
	});
});

describe("runner", () => {
	it("[13] generates one describe per registry entry", () => {
		const described: string[] = [];
		const its: string[] = [];
		const runner = {
			describe: ((name: string, body: () => void) => {
				described.push(name);
				body();
			}) as never,
			it: ((name: string) => {
				its.push(name);
			}) as never,
		};
		const registry = [entryFor("s", "one"), entryFor("s", "two", fakeApi("correct", new Map()))];
		const names = registerIsolationSuite(registry, ctx, runner);
		expect(described).toEqual(names);
		expect(described).toHaveLength(2);
		expect(its).toHaveLength(3); // db check for both, api check for the second
	});

	it("registers nothing for an empty registry", () => {
		expect(registerIsolationSuite([], ctx)).toEqual([]);
	});
});

describe("cleanup", () => {
	const exists = async (name: string) =>
		(await pools.owner.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [name])).rowCount === 1;

	it("[15] drops the throwaway schema even when a check fails", async () => {
		let name = "";
		await expect(
			withThrowawaySchema(pools.owner, async (schema) => {
				name = schema;
				await createFixtureTables(schema);
				expect(await exists(schema)).toBe(true);
				const result = await runDbIsolationCheck(entryFor(schema, "iso_leaky"), ctx());
				expect(result.ok, "leaky check must fail, which fails this test body on purpose").toBe(true);
			}),
		).rejects.toThrow();
		expect(name).not.toBe("");
		expect(await exists(name)).toBe(false);
	});
});
