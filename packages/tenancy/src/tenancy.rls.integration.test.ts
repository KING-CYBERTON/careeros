import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createPools, createTestSchema, getTestEnv, type TestPools, type TestSchema } from "@careeros/testing";

// P1-Q01: real row-level security through `withOrgContext`, then heavy interleaved traffic. No feature table has RLS
// yet (P1-T04), so a temporary probe table with the D4 policy stands in. Skipped only when the CAREEROS_TEST_*
// variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const POOL_MAX = 5;
const ORGS = ["org_a", "org_b", "org_c"] as const;
const ROWS_PER_ORG = 20;
const CALLS = 300;
const TABLE = "careeros_tenancy_probe";
const SEED = 0x51_c0_ffee;

/** Small seeded PRNG (mulberry32) so the call plan is identical on every run. */
function seededRandom(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d_2b_79_f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type CallPlan = {
	org: (typeof ORGS)[number];
	delayMs: number;
	useTransaction: boolean;
	/** 0 = before the first query, 1 = between the queries, 2 = after the second; undefined = does not throw. */
	throwAt: 0 | 1 | 2 | undefined;
};

function makePlan(count: number, seed: number, throwRate: number): CallPlan[] {
	const random = seededRandom(seed);
	return Array.from({ length: count }, () => {
		const org = ORGS[Math.floor(random() * ORGS.length)] as (typeof ORGS)[number];
		const delayMs = Math.floor(random() * 16);
		const useTransaction = random() < 0.4;
		const throwAt = random() < throwRate ? (Math.floor(random() * 3) as 0 | 1 | 2) : undefined;
		return { org, delayMs, useTransaction, throwAt };
	});
}

describe.skipIf(!configured)("tenancy under RLS and load (real Postgres)", () => {
	let pools: TestPools;
	let schema: TestSchema;
	let tenancy: typeof import("./index");
	let client: typeof import("@reactive-resume/db/client");
	let sql: typeof import("drizzle-orm").sql;

	const expectedIds = (org: string) =>
		Array.from({ length: ROWS_PER_ORG }, (_, i) => `${org}_${String(i).padStart(2, "0")}`);
	const setting = async () => {
		const { rows } = await client
			.getPool()
			.query<{ value: string | null }>("select current_setting('app.current_org_id', true) as value");
		return rows[0]?.value ?? null;
	};
	const rowsViaPool = async () => {
		const { rows } = await client
			.getPool()
			.query<{ id: string; organization_id: string }>(`select id, organization_id from ${TABLE} order by id`);
		return rows;
	};
	const rowsViaDb = async () => {
		const result = await client.db.execute<{ id: string; organization_id: string }>(
			sql`select id, organization_id from careeros_tenancy_probe order by id`,
		);
		return result.rows;
	};
	const rowsViaTransaction = () =>
		client.db.transaction(async (tx) => {
			const result = await tx.execute<{ id: string; organization_id: string }>(
				sql`select id, organization_id from careeros_tenancy_probe order by id`,
			);
			return result.rows;
		});

	beforeAll(async () => {
		const env = getTestEnv();
		pools = createPools(env);
		schema = await createTestSchema(pools.owner, "tenancy_rls");
		await pools.owner.query(
			`create table "${schema.name}"."${TABLE}" (id text primary key, organization_id text not null, payload text)`,
		);
		await pools.owner.query(`alter table "${schema.name}"."${TABLE}" enable row level security`);
		await pools.owner.query(`alter table "${schema.name}"."${TABLE}" force row level security`);
		await pools.owner.query(
			`create policy tenant_isolation on "${schema.name}"."${TABLE}" using (organization_id = current_setting('app.current_org_id', true)) with check (organization_id = current_setting('app.current_org_id', true))`,
		);
		await pools.owner.query(`grant select, insert, update, delete on "${schema.name}"."${TABLE}" to careeros_app`);
		for (const org of ORGS) {
			for (const id of expectedIds(org)) {
				await pools.owner.query(
					`insert into "${schema.name}"."${TABLE}" (id, organization_id, payload) values ($1, $2, 'x')`,
					[id, org],
				);
			}
		}
		const url = new URL(env.appUrl);
		url.searchParams.set("options", `-c search_path=${schema.name},public`);
		// The db client reads these at import time, so set them before the dynamic imports.
		process.env.DATABASE_URL = url.toString();
		process.env.DATABASE_POOL_MAX = String(POOL_MAX);
		client = await import("@reactive-resume/db/client");
		sql = (await import("drizzle-orm")).sql;
		tenancy = await import("./index");
	}, 60_000);

	afterAll(async () => {
		await client?.getPool().end();
		await pools?.owner.query(`drop table if exists "${schema.name}"."${TABLE}"`).catch(() => {});
		await schema?.drop();
		await pools?.close();
	});

	it("connects as careeros_app, which is neither superuser nor BYPASSRLS", async () => {
		const { rows } = await client
			.getPool()
			.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
				"select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
			);
		expect(rows).toEqual([{ current_user: "careeros_app", rolsuper: false, rolbypassrls: false }]);
		const { rows: forced } = await pools.owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
			`select relrowsecurity, relforcerowsecurity from pg_class where oid = '"${schema.name}"."${TABLE}"'::regclass`,
		);
		expect(forced).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
	});

	describe("RLS through the scope", () => {
		it("shows only the scope's org through both db and getPool()", async () => {
			await tenancy.withOrgContext("org_a", async () => {
				for (const read of [rowsViaPool, rowsViaDb, rowsViaTransaction]) {
					const rows = await read();
					expect(rows.map((row) => row.id)).toEqual(expectedIds("org_a"));
					expect(new Set(rows.map((row) => row.organization_id))).toEqual(new Set(["org_a"]));
				}
			});
		});

		it("refuses to insert a row for another org", async () => {
			await tenancy.withOrgContext("org_a", async () => {
				await expect(
					client.getPool().query(`insert into ${TABLE} (id, organization_id) values ('evil_pool', 'org_b')`),
				).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
			});
			await tenancy.withOrgContext("org_a", async () => {
				await expect(
					client.db.execute(sql`insert into careeros_tenancy_probe (id, organization_id) values ('evil_db', 'org_b')`),
				).rejects.toThrow();
			});
			const { rows } = await pools.owner.query(`select 1 from "${schema.name}"."${TABLE}" where id like 'evil_%'`);
			expect(rows).toHaveLength(0);
		});

		it("accepts an insert for the scope's own org", async () => {
			await tenancy.withOrgContext("org_a", async () => {
				await client.getPool().query(`insert into ${TABLE} (id, organization_id) values ('own_row', 'org_a')`);
				await client.getPool().query(`delete from ${TABLE} where id = 'own_row'`);
			});
		});

		it("fails closed outside any scope: no rows, no inserts", async () => {
			expect(await rowsViaPool()).toHaveLength(0);
			expect(await rowsViaDb()).toHaveLength(0);
			await expect(
				client.getPool().query(`insert into ${TABLE} (id, organization_id) values ('outside', 'org_a')`),
			).rejects.toMatchObject({ code: "42501" });
		});

		it("leaves no org setting on the next checkout after a scope ends", async () => {
			await tenancy.withOrgContext("org_a", async () => "done");
			const value = await setting();
			expect(value === null || value === "").toBe(true);
			expect(await rowsViaPool()).toHaveLength(0);
		});
	});

	describe("interleaved load", () => {
		const pool = () => client.getPool();

		/** Executes a plan with `POOL_MAX` clients; samples pool counters to record peaks. */
		async function run(plan: CallPlan[]) {
			const peaks = { totalCount: 0, waitingCount: 0 };
			const sample = () => {
				peaks.totalCount = Math.max(peaks.totalCount, pool().totalCount);
				peaks.waitingCount = Math.max(peaks.waitingCount, pool().waitingCount);
			};
			const timer = setInterval(sample, 1);
			const started = performance.now();
			const settled = await Promise.allSettled(
				plan.map((call) => {
					sample();
					return tenancy.withOrgContext(call.org, async () => {
						const read = call.useTransaction ? rowsViaTransaction : rowsViaDb;
						if (call.throwAt === 0) throw new Error("planned failure");
						const before = await read();
						await sleep(call.delayMs);
						if (call.throwAt === 1) throw new Error("planned failure");
						const after = call.useTransaction ? await rowsViaPool() : await rowsViaTransaction();
						if (call.throwAt === 2) throw new Error("planned failure");
						return { before, after, setting: await setting(), current: tenancy.currentOrgId() };
					});
				}),
			);
			const wallMs = performance.now() - started;
			clearInterval(timer);
			sample();
			return { settled, peaks, wallMs };
		}

		function expectOnlyOwnOrg(plan: CallPlan[], settled: PromiseSettledResult<unknown>[]) {
			let survivors = 0;
			settled.forEach((result, index) => {
				const call = plan[index] as CallPlan;
				if (call.throwAt !== undefined) {
					expect(result.status).toBe("rejected");
					expect((result as PromiseRejectedResult).reason).toMatchObject({ message: "planned failure" });
					return;
				}
				survivors += 1;
				expect(result.status).toBe("fulfilled");
				const value = (
					result as PromiseFulfilledResult<{
						before: { id: string; organization_id: string }[];
						after: { id: string; organization_id: string }[];
						setting: string | null;
						current: string | undefined;
					}>
				).value;
				expect(value.before.map((row) => row.id)).toEqual(expectedIds(call.org));
				expect(value.after.map((row) => row.id)).toEqual(expectedIds(call.org));
				expect(value.before.every((row) => row.organization_id === call.org)).toBe(true);
				expect(value.after.every((row) => row.organization_id === call.org)).toBe(true);
				expect(value.setting).toBe(call.org);
				expect(value.current).toBe(call.org);
			});
			return survivors;
		}

		it(`isolates ${CALLS} concurrent calls over ${ORGS.length} orgs with a pool of ${POOL_MAX}`, async () => {
			expect(pool().options.max).toBe(POOL_MAX);
			const plan = makePlan(CALLS, SEED, 0);
			const { settled, peaks, wallMs } = await run(plan);
			console.log(
				`[P1-Q01] load: ${CALLS} calls, peak waitingCount=${peaks.waitingCount}, peak totalCount=${peaks.totalCount}, wall=${Math.round(wallMs)} ms`,
			);
			expect(settled.filter((result) => result.status === "rejected")).toHaveLength(0);
			expect(expectOnlyOwnOrg(plan, settled)).toBe(CALLS);
			expect(peaks.totalCount).toBeLessThanOrEqual(POOL_MAX);
			expect(pool().totalCount).toBeLessThanOrEqual(POOL_MAX);
			expect(pool().waitingCount).toBe(0);
		}, 60_000);

		it("survives about 10% of the calls throwing at random points", async () => {
			const plan = makePlan(CALLS, SEED + 1, 0.1);
			const failing = plan.filter((call) => call.throwAt !== undefined).length;
			expect(failing).toBeGreaterThan(10);
			expect(failing).toBeLessThan(60);
			const { settled, peaks, wallMs } = await run(plan);
			console.log(
				`[P1-Q01] error load: ${failing} failing of ${CALLS}, peak waitingCount=${peaks.waitingCount}, peak totalCount=${peaks.totalCount}, wall=${Math.round(wallMs)} ms`,
			);
			expect(expectOnlyOwnOrg(plan, settled)).toBe(CALLS - failing);
			expect(peaks.totalCount).toBeLessThanOrEqual(POOL_MAX);
			expect(pool().totalCount).toBeLessThanOrEqual(POOL_MAX);
			expect(pool().waitingCount).toBe(0);
		}, 60_000);

		it("recovers after the failures: a further 50 calls succeed on healthy clients", async () => {
			const plan = makePlan(50, SEED + 2, 0);
			const { settled, peaks } = await run(plan);
			expect(settled.filter((result) => result.status === "rejected")).toHaveLength(0);
			expect(expectOnlyOwnOrg(plan, settled)).toBe(50);
			expect(peaks.totalCount).toBeLessThanOrEqual(POOL_MAX);
			expect(pool().totalCount).toBeLessThanOrEqual(POOL_MAX);
			// Nothing leaks outside the scopes.
			const value = await setting();
			expect(value === null || value === "").toBe(true);
		}, 60_000);
	});
});
