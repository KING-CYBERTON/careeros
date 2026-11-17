import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { withOrgContext } from "@careeros/tenancy";
import { createPools, type TestPools } from "@careeros/testing";
import { getPool, withDatabasePool } from "@reactive-resume/db/client";
import { DiscoveryError, mapWithConcurrency, runDiscovery, type BoardLoader } from "./run";
import { BoardFetchError, type BoardRef, type NormalizedJob } from "./types";

// P4-T01: discovery against a real database as `careeros_app` (not superuser, not BYPASSRLS): row-level security on the
// three tables, the unique key that keeps a dismissed job away, re-runs, counts and the 50-board timing. No test reaches
// a real job board: every board is answered by a fake loader. Skipped only when the CAREEROS_TEST_* variables are absent;
// CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const posting = (
	source: BoardRef["source"],
	board: string,
	n: number,
	extra: Partial<NormalizedJob> = {},
): NormalizedJob => ({
	source,
	externalId: `${board}-${n}`,
	boardToken: board,
	title: n % 2 === 0 ? "Backend Engineer" : "Office Manager",
	company: `Company ${board}`,
	location: "Nairobi, Kenya",
	remote: "hybrid",
	url: `https://example.test/${board}/${n}`,
	postedAt: new Date("2026-10-01T00:00:00Z"),
	descriptionHtml: "<p>TypeScript and PostgreSQL.</p>",
	...extra,
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!configured)("job discovery on a real database", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `disc-org-a-${run}`,
		orgB: `disc-org-b-${run}`,
		userA: `disc-user-a-${run}`,
		userA2: `disc-user-a2-${run}`,
		userB: `disc-user-b-${run}`,
		sourceA: `disc-source-a-${run}`,
		sourceA2: `disc-source-a2-${run}`,
		sourceB: `disc-source-b-${run}`,
	};
	let pools: TestPools;

	const inOrg = <T>(orgId: string, fn: () => Promise<T>) =>
		withDatabasePool(pools.app, () => withOrgContext(orgId, fn));
	const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
		(await pools.owner.query<T>(sql, params)).rows;
	const count = async (table: string, where: string, params: unknown[]) =>
		Number((await rows<{ n: string }>(`select count(*) as n from ${table} where ${where}`, params))[0]?.n);

	const profile = {
		titles: ["Backend Engineer"],
		skills: ["TypeScript", "PostgreSQL"],
		locations: ["Nairobi"],
		remote: "hybrid",
	};
	const addSource = async (id: string, orgId: string, userId: string, boards: BoardRef[]) => {
		await pools.owner.query(
			`insert into job_source (id, organization_id, user_id, name, titles, skills, locations, remote, boards)
			 values ($1, $2, $3, 'Test automation', $4, $5, $6, $7, $8::jsonb)`,
			[id, orgId, userId, profile.titles, profile.skills, profile.locations, profile.remote, JSON.stringify(boards)],
		);
	};
	const boards: BoardRef[] = [
		{ source: "greenhouse", token: "alpha" },
		{ source: "lever", token: "beta" },
		{ source: "ashby", token: "gamma" },
	];
	// alpha: 1..3. beta: 3 again (same source+id as alpha's 3? no: a different source) plus 4. gamma: fails with a 503.
	const loader: BoardLoader = (ref) => {
		if (ref.token === "alpha") return Promise.resolve([1, 2, 3].map((n) => posting("greenhouse", "alpha", n)));
		if (ref.token === "beta")
			return Promise.resolve([posting("lever", "beta", 1), posting("lever", "beta", 1), posting("lever", "beta", 2)]);
		return Promise.reject(new BoardFetchError("http_status", "The board answered 503.", 503));
	};

	beforeAll(async () => {
		pools = createPools();
		for (const orgId of [ids.orgA, ids.orgB])
			await pools.owner.query(`insert into organization (id, name, slug) values ($1, $1, $1)`, [orgId]);
		for (const userId of [ids.userA, ids.userA2, ids.userB])
			await pools.owner.query(
				`insert into "user" (id, name, email, username, display_username) values ($1, 'Test user', $1 || '@example.test', $1, $1)`,
				[userId],
			);
		await addSource(ids.sourceA, ids.orgA, ids.userA, boards);
		await addSource(ids.sourceA2, ids.orgA, ids.userA2, boards);
		await addSource(ids.sourceB, ids.orgB, ids.userB, boards);
	}, 60_000);

	afterAll(async () => {
		await pools?.owner.query(`delete from organization where id = any($1::text[])`, [[ids.orgA, ids.orgB]]);
		await pools?.owner.query(`delete from "user" where id = any($1::text[])`, [[ids.userA, ids.userA2, ids.userB]]);
		await pools?.close();
	});

	describe("a run", () => {
		it("fetches, de-dupes, scores and records the counts; a failed board makes the run partial", async () => {
			const summary = await inOrg(ids.orgA, () => runDiscovery(ids.sourceA, { loadBoard: loader }));
			// 3 from alpha, 3 from beta (one repeated inside the run), none from gamma.
			expect(summary).toMatchObject({ status: "partial", fetched: 6, new: 5, duplicate: 1, scored: 5, aiMatched: 0 });
			expect(summary.errors).toEqual([
				{ source: "ashby", token: "gamma", code: "http_status", status: 503, reason: "The board answered 503." },
			]);

			const [recorded] = await rows(`select * from discovery_run where id = $1`, [summary.runId]);
			expect(recorded).toMatchObject({
				organization_id: ids.orgA,
				job_source_id: ids.sourceA,
				status: "partial",
				fetched: 6,
				new: 5,
				duplicate: 1,
				scored: 5,
				ai_matched: 0,
			});
			expect(recorded?.finished_at).toBeInstanceOf(Date);
			expect(JSON.stringify(recorded?.errors)).not.toMatch(/body|<html/i);

			const [source] = await rows<{ last_run_at: Date | null }>(`select last_run_at from job_source where id = $1`, [
				ids.sourceA,
			]);
			expect(source?.last_run_at).toBeInstanceOf(Date);
		});

		it("stores scored, sanitized-source rows owned by the automation's user, tied to the run", async () => {
			const stored = await rows<{
				user_id: string;
				organization_id: string;
				status: string;
				local_score: string;
				first_seen_run_id: string;
				job_source_id: string;
				title: string;
			}>(`select * from discovered_job where job_source_id = $1 order by external_id, source`, [ids.sourceA]);
			expect(stored).toHaveLength(5);
			for (const row of stored) {
				expect(row).toMatchObject({ user_id: ids.userA, organization_id: ids.orgA, status: "new" });
				expect(Number(row.local_score)).toBeGreaterThan(0);
				expect(Number(row.local_score)).toBeLessThanOrEqual(100);
				expect(row.first_seen_run_id).toBeTruthy();
			}
			const best = stored.find((row) => row.title === "Backend Engineer");
			const worst = stored.find((row) => row.title === "Office Manager");
			expect(Number(best?.local_score)).toBeGreaterThan(Number(worst?.local_score));
		});

		it("a re-run creates no duplicates: everything it finds is counted as a duplicate", async () => {
			const before = await count("discovered_job", "organization_id = $1", [ids.orgA]);
			const summary = await inOrg(ids.orgA, () => runDiscovery(ids.sourceA, { loadBoard: loader }));
			expect(summary).toMatchObject({ status: "partial", fetched: 6, new: 0, duplicate: 6, scored: 5 });
			expect(await count("discovered_job", "organization_id = $1", [ids.orgA])).toBe(before);
		});

		it("a dismissed or accepted job never comes back, and keeps its status", async () => {
			await pools.owner.query(
				`update discovered_job set status = 'dismissed' where organization_id = $1 and source = 'greenhouse' and external_id = 'alpha-1'`,
				[ids.orgA],
			);
			await pools.owner.query(
				`update discovered_job set status = 'accepted' where organization_id = $1 and source = 'lever' and external_id = 'beta-2'`,
				[ids.orgA],
			);
			const before = await count("discovered_job", "organization_id = $1", [ids.orgA]);

			const summary = await inOrg(ids.orgA, () => runDiscovery(ids.sourceA, { loadBoard: loader }));

			expect(summary.new).toBe(0);
			expect(await count("discovered_job", "organization_id = $1", [ids.orgA])).toBe(before);
			const statuses = await rows<{ external_id: string; status: string }>(
				`select external_id, status from discovered_job where organization_id = $1 and external_id in ('alpha-1', 'beta-2') order by external_id`,
				[ids.orgA],
			);
			expect(statuses).toEqual([
				{ external_id: "alpha-1", status: "dismissed" },
				{ external_id: "beta-2", status: "accepted" },
			]);
		});

		it("the unique key holds in the database too, for any writer", async () => {
			await expect(
				pools.owner.query(
					`insert into discovered_job (id, organization_id, user_id, source, external_id, board_token, title, company, url, local_score)
					 values ($1, $2, $3, 'greenhouse', 'alpha-1', 'alpha', 'x', 'x', 'https://example.test/x', 1)`,
					[`dup-${run}`, ids.orgA, ids.userA],
				),
			).rejects.toMatchObject({ code: "23505" });
		});

		it("deleting the automation keeps the postings, with their status, so a dismissed one still stays away", async () => {
			await pools.owner.query(`delete from job_source where id = $1`, [ids.sourceA]);
			expect(await count("discovery_run", "job_source_id = $1", [ids.sourceA])).toBe(0);
			const kept = await rows<{
				job_source_id: string | null;
				first_seen_run_id: string | null;
				organization_id: string;
				status: string;
			}>(
				`select job_source_id, first_seen_run_id, organization_id, status from discovered_job where organization_id = $1 and external_id = 'alpha-1'`,
				[ids.orgA],
			);
			expect(kept).toEqual([
				{ job_source_id: null, first_seen_run_id: null, organization_id: ids.orgA, status: "dismissed" },
			]);

			// A new automation of the same owner over the same boards cannot bring the dismissed posting back.
			const replacement = `disc-source-a-new-${run}`;
			await addSource(replacement, ids.orgA, ids.userA, boards);
			const summary = await inOrg(ids.orgA, () => runDiscovery(replacement, { loadBoard: loader }));
			expect(summary.new).toBe(0);
			const [again] = await rows<{ status: string }>(
				`select status from discovered_job where organization_id = $1 and external_id = 'alpha-1'`,
				[ids.orgA],
			);
			expect(again?.status).toBe("dismissed");
		});

		it("is per user: another user of the same organization still finds the same postings", async () => {
			const summary = await inOrg(ids.orgA, () => runDiscovery(ids.sourceA2, { loadBoard: loader }));
			expect(summary).toMatchObject({ new: 5, duplicate: 1 });
			expect(await count("discovered_job", "organization_id = $1 and user_id = $2", [ids.orgA, ids.userA2])).toBe(5);
		});

		it("is per organization: the same postings are new in another organization", async () => {
			const summary = await inOrg(ids.orgB, () => runDiscovery(ids.sourceB, { loadBoard: loader }));
			expect(summary).toMatchObject({ new: 5 });
		});

		it("marks the run failed when every board fails, and succeeded when none does", async () => {
			const failing: BoardLoader = () =>
				Promise.reject(new BoardFetchError("timeout", "The board did not answer in time."));
			const failedSummary = await inOrg(ids.orgB, () => runDiscovery(ids.sourceB, { loadBoard: failing }));
			expect(failedSummary).toMatchObject({ status: "failed", fetched: 0, new: 0 });
			expect(failedSummary.errors).toHaveLength(3);

			const fine: BoardLoader = (ref) => Promise.resolve([posting("greenhouse", ref.token, 100)]);
			const okSummary = await inOrg(ids.orgB, () => runDiscovery(ids.sourceB, { loadBoard: fine }));
			expect(okSummary).toMatchObject({ status: "succeeded", new: 3, errors: [] });
		});

		it("records an unexpected error from a loader as a fixed reason, never its message", async () => {
			const leaky: BoardLoader = () => Promise.reject(new Error("connect ECONNREFUSED 10.9.9.9:443 SECRET-TOKEN"));
			const summary = await inOrg(ids.orgB, () => runDiscovery(ids.sourceB, { loadBoard: leaky }));
			expect(JSON.stringify(summary.errors)).not.toMatch(/10\.9\.9\.9|SECRET/);
			const [stored] = await rows(`select errors from discovery_run where id = $1`, [summary.runId]);
			expect(JSON.stringify(stored?.errors)).not.toMatch(/10\.9\.9\.9|SECRET/);
		});

		it("an automation with no boards succeeds with nothing", async () => {
			const bare = `disc-source-bare-${run}`;
			await addSource(bare, ids.orgB, ids.userB, []);
			const summary = await inOrg(ids.orgB, () => runDiscovery(bare, { loadBoard: loader }));
			expect(summary).toMatchObject({ status: "succeeded", fetched: 0, new: 0, duplicate: 0, scored: 0 });
		});
	});

	describe("row-level security, as careeros_app", () => {
		it("connects as a role that is neither superuser nor BYPASSRLS", async () => {
			const { rows: role } = await pools.app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
				"select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
			);
			expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
		});

		it.each(["job_source", "discovery_run", "discovered_job"])(
			"%s: row security is enabled and forced",
			async (table) => {
				const [flags] = await rows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
					`select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass`,
					[`public.${table}`],
				);
				expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
				const policies = await rows<{ policyname: string }>(
					`select policyname from pg_policies where schemaname = 'public' and tablename = $1 order by policyname`,
					[table],
				);
				expect(policies.map((policy) => policy.policyname)).toEqual(["owner_access", "tenant_isolation"]);
			},
		);

		it.each(["job_source", "discovery_run", "discovered_job"])(
			"%s: an organization sees only its own rows",
			async (table) => {
				const seenByB = await inOrg(
					ids.orgB,
					async () => (await getPool().query(`select organization_id from ${table}`)).rows,
				);
				expect(seenByB.length).toBeGreaterThan(0);
				expect(new Set(seenByB.map((row: { organization_id: string }) => row.organization_id))).toEqual(
					new Set([ids.orgB]),
				);
				const seenByA = await inOrg(
					ids.orgA,
					async () => (await getPool().query(`select organization_id from ${table}`)).rows,
				);
				expect(new Set(seenByA.map((row: { organization_id: string }) => row.organization_id))).toEqual(
					new Set([ids.orgA]),
				);
			},
		);

		it("with no organization set, nothing is visible and nothing can be written", async () => {
			for (const table of ["job_source", "discovery_run", "discovered_job"])
				expect((await pools.app.query(`select 1 from ${table}`)).rowCount).toBe(0);
			await expect(
				pools.app.query(`insert into job_source (id, organization_id, user_id, name) values ($1, $2, $3, 'x')`, [
					`rls-${run}`,
					ids.orgA,
					ids.userA,
				]),
			).rejects.toMatchObject({ code: "42501" });
		});

		it("an organization cannot write a row into another organization", async () => {
			await expect(
				inOrg(ids.orgB, () =>
					getPool().query(`insert into job_source (id, organization_id, user_id, name) values ($1, $2, $3, 'x')`, [
						`rls2-${run}`,
						ids.orgA,
						ids.userA,
					]),
				),
			).rejects.toMatchObject({ code: "42501" });
		});

		it("an organization cannot run, change or delete another organization's automation", async () => {
			await expect(inOrg(ids.orgB, () => runDiscovery(ids.sourceA2, { loadBoard: loader }))).rejects.toBeInstanceOf(
				DiscoveryError,
			);
			const changed = await inOrg(ids.orgB, () =>
				getPool().query(`update job_source set name = 'hacked' where id = $1`, [ids.sourceA2]),
			);
			expect(changed.rowCount).toBe(0);
			const removed = await inOrg(ids.orgB, () =>
				getPool().query(`delete from job_source where id = $1`, [ids.sourceA2]),
			);
			expect(removed.rowCount).toBe(0);
			expect(await count("job_source", "id = $1 and name = 'Test automation'", [ids.sourceA2])).toBe(1);
		});

		it("refuses to run outside an organization scope", async () => {
			await expect(
				withDatabasePool(pools.app, () => runDiscovery(ids.sourceA2, { loadBoard: loader })),
			).rejects.toMatchObject({
				code: "org_required",
			});
		});

		it("the composite keys refuse a posting or a run that points at another organization's automation", async () => {
			await expect(
				pools.owner.query(`insert into discovery_run (id, organization_id, job_source_id) values ($1, $2, $3)`, [
					`x-run-${run}`,
					ids.orgB,
					ids.sourceA2,
				]),
			).rejects.toMatchObject({ code: "23503" });
			await expect(
				pools.owner.query(
					`insert into discovered_job (id, organization_id, user_id, job_source_id, source, external_id, board_token, title, company, url, local_score)
					 values ($1, $2, $3, $4, 'lever', 'x', 'x', 'x', 'x', 'https://example.test/x', 1)`,
					[`x-job-${run}`, ids.orgB, ids.userB, ids.sourceA2],
				),
			).rejects.toMatchObject({ code: "23503" });
			// Same organization, but another user's automation.
			await expect(
				pools.owner.query(
					`insert into discovered_job (id, organization_id, user_id, job_source_id, source, external_id, board_token, title, company, url, local_score)
					 values ($1, $2, $3, $4, 'lever', 'y', 'x', 'x', 'x', 'https://example.test/y', 1)`,
					[`y-job-${run}`, ids.orgA, ids.userA, ids.sourceA2],
				),
			).rejects.toMatchObject({ code: "23503" });
		});
	});

	describe("table constraints", () => {
		const insertSource = (overrides: Record<string, unknown>) => {
			const columns = {
				id: `chk-${randomUUID()}`,
				organization_id: ids.orgA,
				user_id: ids.userA,
				name: "x",
				...overrides,
			};
			const names = Object.keys(columns);
			return pools.owner.query(
				`insert into job_source (${names.join(", ")}) values (${names.map((_, index) => `$${index + 1}`).join(", ")})`,
				Object.values(columns),
			);
		};

		it("limits boards to 100, ai_top_n to 0..50, and the vocabularies", async () => {
			const tooMany = JSON.stringify(
				Array.from({ length: 101 }, (_, index) => ({ source: "lever", token: `b${index}` })),
			);
			await expect(insertSource({ boards: tooMany })).rejects.toMatchObject({ code: "23514" });
			await expect(insertSource({ boards: JSON.stringify({ not: "a list" }) })).rejects.toMatchObject({
				code: "23514",
			});
			await expect(insertSource({ ai_top_n: 51 })).rejects.toMatchObject({ code: "23514" });
			await expect(insertSource({ ai_top_n: -1 })).rejects.toMatchObject({ code: "23514" });
			await expect(insertSource({ remote: "sometimes" })).rejects.toMatchObject({ code: "23514" });
			await expect(insertSource({ schedule: "hourly" })).rejects.toMatchObject({ code: "23514" });
			await expect(insertSource({ ai_top_n: 0 })).resolves.toBeTruthy();
			await expect(insertSource({ ai_top_n: 50 })).resolves.toBeTruthy();
		});

		it("stores only https addresses and scores from 0 to 100", async () => {
			const base = {
				organization_id: ids.orgA,
				user_id: ids.userA,
				source: "lever",
				board_token: "t",
				title: "t",
				company: "c",
				local_score: 10,
				url: "https://example.test/ok",
			};
			const insertJob = (overrides: Record<string, unknown>) => {
				const columns = { id: `chk-${randomUUID()}`, external_id: randomUUID(), ...base, ...overrides };
				const names = Object.keys(columns);
				return pools.owner.query(
					`insert into discovered_job (${names.join(", ")}) values (${names.map((_, index) => `$${index + 1}`).join(", ")})`,
					Object.values(columns),
				);
			};
			await expect(insertJob({ url: "http://example.test/x" })).rejects.toMatchObject({ code: "23514" });
			await expect(insertJob({ url: "javascript:alert(1)" })).rejects.toMatchObject({ code: "23514" });
			await expect(insertJob({ local_score: 100.01 })).rejects.toMatchObject({ code: "23514" });
			await expect(insertJob({ local_score: -1 })).rejects.toMatchObject({ code: "23514" });
			await expect(insertJob({ ai_score: 101 })).rejects.toMatchObject({ code: "23514" });
			await expect(insertJob({ status: "archived" })).rejects.toMatchObject({ code: "23514" });
			await expect(insertJob({ source: "indeed" })).rejects.toMatchObject({ code: "23514" });
			await expect(insertJob({ title: "x".repeat(301) })).rejects.toMatchObject({ code: "23514" });
			await expect(insertJob({})).resolves.toBeTruthy();
		});
	});

	describe("performance", () => {
		it("50 boards with realistic latency finish well within 2 minutes, at most 5 at a time", async () => {
			const perfSource = `disc-source-perf-${run}`;
			const manyBoards: BoardRef[] = Array.from({ length: 50 }, (_, index) => ({
				source: (["greenhouse", "lever", "lever_eu", "ashby"] as const)[index % 4] as BoardRef["source"],
				token: `perf-${index}`,
			}));
			await addSource(perfSource, ids.orgB, ids.userB, manyBoards);

			let inFlight = 0;
			let peak = 0;
			// 300 to 900 ms per board, spread by a fixed rule so the run is repeatable.
			const slow: BoardLoader = async (ref) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				const index = Number(ref.token.split("-")[1]);
				await sleep(300 + ((index * 137) % 7) * 100);
				inFlight--;
				return Array.from({ length: 40 }, (_, n) => posting(ref.source, ref.token, n));
			};

			const started = Date.now();
			const summary = await inOrg(ids.orgB, () => runDiscovery(perfSource, { loadBoard: slow }));
			const seconds = (Date.now() - started) / 1000;
			console.info(
				`P4-T01 timing: 50 boards, 2000 postings, mocked latency 0.3-0.9 s each: ${seconds.toFixed(1)} s, peak ${peak} in flight`,
			);

			expect(summary).toMatchObject({ status: "succeeded", fetched: 2000, new: 2000, duplicate: 0, scored: 2000 });
			expect(peak).toBeLessThanOrEqual(5);
			expect(peak).toBeGreaterThan(1);
			expect(seconds).toBeLessThan(120);
		}, 150_000);
	});
});

describe("mapWithConcurrency", () => {
	it("never runs more than the limit at once, keeps the order and surfaces nothing lost", async () => {
		let inFlight = 0;
		let peak = 0;
		const out = await mapWithConcurrency(
			Array.from({ length: 23 }, (_, index) => index),
			5,
			async (item) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await sleep(5);
				inFlight--;
				return item * 2;
			},
		);
		expect(peak).toBe(5);
		expect(out).toEqual(Array.from({ length: 23 }, (_, index) => index * 2));
	});

	it("handles an empty list", async () => {
		expect(await mapWithConcurrency([], 5, (item: number) => Promise.resolve(item))).toEqual([]);
	});
});
