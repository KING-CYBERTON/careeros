import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createRouterClient } from "@orpc/server";
import { Pool } from "pg";
import { withDatabasePool } from "@reactive-resume/db/client";
import { discoveryRouter } from "./router";

// This suite needs the real organization scope, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());
// CAREEROS (P3-T02): the shared setup stubs billing; the plan gate here reads the real entitlements.
vi.mock("@careeros/billing", async (importOriginal) => importOriginal());

// No test reaches a real job board: the run uses a fixed loader.
vi.mock("@careeros/job-discovery", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@careeros/job-discovery")>();
	const loadBoard = (ref: { source: "greenhouse" | "lever" | "lever_eu" | "ashby"; token: string }) =>
		Promise.resolve(
			[1, 2, 3].map((n) => ({
				source: ref.source,
				externalId: `${ref.token}-${n}`,
				boardToken: ref.token,
				title: n === 1 ? "Backend Engineer" : "Office Manager",
				company: "Example Co",
				location: "Nairobi, Kenya",
				remote: "hybrid" as const,
				url: `https://example.test/${ref.token}/${n}`,
				postedAt: null,
				descriptionHtml: "<p>TypeScript</p>",
			})),
		);
	return { ...actual, runDiscovery: (id: string) => actual.runDiscovery(id, { loadBoard }) };
});

// P4-T01: the discovery API through the real router, as `careeros_app`. Skipped only when the CAREEROS_TEST_* variables
// are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("discovery API", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `dapi-org-a-${run}`,
		orgB: `dapi-org-b-${run}`,
		// No flag and the default plan: job_discovery is off here.
		orgC: `dapi-org-c-${run}`,
		userA: `dapi-user-a-${run}`,
		userA2: `dapi-user-a2-${run}`,
		userB: `dapi-user-b-${run}`,
		userC: `dapi-user-c-${run}`,
		// Two users that only exercise the cap of 20 automations (Q228).
		capA: `dapi-cap-a-${run}`,
		capB: `dapi-cap-b-${run}`,
	};
	const allUsers = [ids.userA, ids.userA2, ids.userB, ids.userC, ids.capA, ids.capB];
	let owner: Pool;
	let app: Pool;

	const user = (id: string) => ({
		id,
		name: id,
		email: `${id}@example.test`,
		emailVerified: true,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	const as = (userId: string, activeOrganizationId: string) =>
		createRouterClient(discoveryRouter, {
			context: {
				locale: "en-US" as const,
				reqHeaders: new Headers(),
				resHeaders: new Headers(),
				authentication: {
					user: user(userId),
					method: "session" as const,
					permissions: ["read", "write", "delete"] as ("read" | "write" | "delete")[],
					activeOrganizationId,
				},
			},
		});
	// Each call goes through the app pool, as the server does.
	const call = <T>(fn: () => Promise<T>) => withDatabasePool(app, fn);
	const alice = () => as(ids.userA, ids.orgA);
	const alice2 = () => as(ids.userA2, ids.orgA);
	const bob = () => as(ids.userB, ids.orgB);
	const carol = () => as(ids.userC, ids.orgC);

	const input = {
		name: "Backend roles",
		titles: ["Backend Engineer"],
		skills: ["TypeScript"],
		boards: [{ source: "lever" as const, token: "acme" }],
	};
	const expectCode = async (promise: Promise<unknown>, code: string) => {
		await expect(promise).rejects.toMatchObject({ code });
	};
	const allowRunNow = (id: string) =>
		owner.query(`update job_source set last_run_at = now() - interval '11 minutes' where id = $1`, [id]);

	beforeAll(async () => {
		owner = new Pool({ connectionString: process.env.CAREEROS_TEST_DATABASE_URL });
		app = new Pool({ connectionString: process.env.CAREEROS_TEST_APP_DATABASE_URL });
		await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, 'A', $1), ($2, 'B', $2), ($3, 'C', $3)`, [
			ids.orgA,
			ids.orgB,
			ids.orgC,
		]);
		// The gate reads getEntitlements: the default plan lacks job_discovery, so organizations A and B get it from an
		// organization feature flag (the proper table, not a bypass). Organization C has none.
		for (const org of [ids.orgA, ids.orgB])
			await owner.query(
				`INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ($1, $2, 'job_discovery', true)`,
				[`dapi-flag-${org}`, org],
			);
		for (const id of allUsers)
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[id],
			);
		for (const [member, org, userId] of [
			["m-a", ids.orgA, ids.userA],
			["m-a2", ids.orgA, ids.userA2],
			["m-b", ids.orgB, ids.userB],
			["m-c", ids.orgC, ids.userC],
			["m-cap-a", ids.orgA, ids.capA],
			["m-cap-a-b", ids.orgB, ids.capA],
			["m-cap-b", ids.orgA, ids.capB],
		] as const)
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [
				`${member}-${run}`,
				org,
				userId,
			]);
	}, 60_000);

	afterAll(async () => {
		await owner?.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [[ids.orgA, ids.orgB, ids.orgC]]);
		await owner?.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [allUsers]);
		await Promise.all([owner?.end(), app?.end()]);
	});

	describe("plan gate", () => {
		const refused = (promise: Promise<unknown>) =>
			expect(promise).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "FEATURE_NOT_IN_PLAN", feature: "job_discovery" },
			});

		it("refuses every procedure for an organization whose plan lacks job_discovery", async () => {
			await refused(call(() => carol().sources.list()));
			await refused(call(() => carol().sources.create({ name: "Nope" })));
			await refused(call(() => carol().sources.update({ id: "x", name: "Nope" })));
			await refused(call(() => carol().sources.delete({ id: "x" })));
			await refused(call(() => carol().runNow({ jobSourceId: "x" })));
			await refused(call(() => carol().jobs.list({ limit: 10, offset: 0 })));
			await refused(call(() => carol().jobs.dismiss({ id: "x" })));
			expect(
				(await owner.query(`select count(*)::int as n from job_source where organization_id = $1`, [ids.orgC])).rows[0],
			).toEqual({ n: 0 });
		});

		it("refuses when the organization flag is explicitly off, even on a plan that has the feature", async () => {
			await owner.query(`UPDATE organization SET plan_id = 'pro' WHERE id = $1`, [ids.orgC]);
			try {
				expect(await call(() => carol().sources.list())).toEqual([]);
				await owner.query(
					`INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ($1, $2, 'job_discovery', false)`,
					[`dapi-flag-off-${ids.orgC}`, ids.orgC],
				);
				await refused(call(() => carol().sources.list()));
			} finally {
				await owner.query(`DELETE FROM feature_flag WHERE organization_id = $1`, [ids.orgC]);
				await owner.query(`UPDATE organization SET plan_id = 'personal' WHERE id = $1`, [ids.orgC]);
			}
			await refused(call(() => carol().sources.list()));
		});
	});

	describe("automations", () => {
		it("creates with defaults, lists, updates and deletes the caller's own", async () => {
			const created = await call(() => alice().sources.create({ name: "Minimal" }));
			expect(created).toMatchObject({
				name: "Minimal",
				titles: [],
				boards: [],
				remote: "any",
				schedule: "daily",
				aiTopN: 10,
				nextRunAt: null,
				lastRunAt: null,
			});

			const full = await call(() => alice().sources.create(input));
			const listed = await call(() => alice().sources.list());
			expect(listed.map((row) => row.id).sort()).toEqual([created.id, full.id].sort());

			const updated = await call(() =>
				alice().sources.update({ id: full.id, name: "Renamed", aiTopN: 0, remote: "remote" }),
			);
			expect(updated).toMatchObject({ name: "Renamed", aiTopN: 0, remote: "remote", titles: ["Backend Engineer"] });

			await call(() => alice().sources.delete({ id: created.id }));
			await expectCode(
				call(() => alice().sources.delete({ id: created.id })),
				"NOT_FOUND",
			);
		});

		it("de-duplicates list entries and boards without regard to case", async () => {
			const created = await call(() =>
				alice().sources.create({
					name: "Dupes",
					skills: ["TypeScript", "typescript", " Rust "],
					boards: [
						{ source: "lever", token: "Acme" },
						{ source: "lever", token: "acme" },
						{ source: "lever_eu", token: "acme" },
					],
				}),
			);
			expect(created.skills).toEqual(["TypeScript", "Rust"]);
			expect(created.boards).toEqual([
				{ source: "lever", token: "Acme" },
				{ source: "lever_eu", token: "acme" },
			]);
		});

		it.each([
			["a token with ../", { boards: [{ source: "lever", token: "../etc" }] }],
			["a token with an encoded slash", { boards: [{ source: "lever", token: "a%2Fb" }] }],
			["a token with @", { boards: [{ source: "lever", token: "a@evil.test" }] }],
			["a URL as the token", { boards: [{ source: "greenhouse", token: "https://evil.test" }] }],
			["an unknown source", { boards: [{ source: "workday", token: "acme" }] }],
			["101 boards", { boards: Array.from({ length: 101 }, (_, index) => ({ source: "lever", token: `b${index}` })) }],
			["ai_top_n above 50", { aiTopN: 51 }],
			["a negative ai_top_n", { aiTopN: -1 }],
			["an empty name", { name: " " }],
			["an unknown remote preference", { remote: "sometimes" }],
			["an unknown schedule", { schedule: "hourly" }],
			["a very long keyword", { keywords: ["x".repeat(101)] }],
			["51 titles", { titles: Array.from({ length: 51 }, (_, index) => `t${index}`) }],
		])("refuses %s", async (_name, patch) => {
			await expectCode(
				call(() => alice().sources.create({ name: "Bad", ...patch } as never)),
				"BAD_REQUEST",
			);
		});

		it("accepts exactly 100 boards", async () => {
			const created = await call(() =>
				alice().sources.create({
					name: "Many",
					boards: Array.from({ length: 100 }, (_, index) => ({ source: "lever" as const, token: `b${index}` })),
				}),
			);
			expect(created.boards).toHaveLength(100);
		});

		it("caps automations at 20 per user per organization", async () => {
			const capped = (userId: string, orgId: string) => as(userId, orgId);
			for (let index = 0; index < 20; index++)
				await call(() => capped(ids.capA, ids.orgA).sources.create({ name: `Cap ${index}` }));
			const refusal = call(() => capped(ids.capA, ids.orgA).sources.create({ name: "Cap 20" }));
			await expectCode(refusal, "BAD_REQUEST");
			await expect(refusal).rejects.toMatchObject({ data: { code: "AUTOMATION_LIMIT_REACHED", limit: 20 } });

			// The cap is per user and per organization.
			await call(() => capped(ids.userA2, ids.orgA).sources.create({ name: "Other user" }));
			await call(() => capped(ids.capA, ids.orgB).sources.create({ name: "Other organization" }));

			// Deleting one frees a slot.
			const [first] = await call(() => capped(ids.capA, ids.orgA).sources.list());
			if (!first) throw new Error("no automation");
			await call(() => capped(ids.capA, ids.orgA).sources.delete({ id: first.id }));
			await call(() => capped(ids.capA, ids.orgA).sources.create({ name: "After delete" }));
			await expectCode(
				call(() => capped(ids.capA, ids.orgA).sources.create({ name: "Over again" })),
				"BAD_REQUEST",
			);
		});

		it("holds the cap when creates run in parallel", async () => {
			const results = await Promise.allSettled(
				Array.from({ length: 25 }, (_, index) =>
					call(() => as(ids.capB, ids.orgA).sources.create({ name: `Parallel ${index}` })),
				),
			);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(20);
			expect(
				(
					await owner.query(`select count(*)::int as n from job_source where user_id = $1 and organization_id = $2`, [
						ids.capB,
						ids.orgA,
					])
				).rows[0],
			).toEqual({ n: 20 });
		});

		it("keeps another user's and another organization's automations out of sight and out of reach", async () => {
			const mine = await call(() => alice().sources.create({ ...input, name: "Alice only" }));
			const sameOrg = await call(() => alice2().sources.list());
			const otherOrg = await call(() => bob().sources.list());
			expect(sameOrg.map((row) => row.id)).not.toContain(mine.id);
			expect(otherOrg.map((row) => row.id)).not.toContain(mine.id);

			for (const stranger of [alice2, bob]) {
				await expectCode(
					call(() => stranger().sources.update({ id: mine.id, name: "hacked" })),
					"NOT_FOUND",
				);
				await expectCode(
					call(() => stranger().sources.delete({ id: mine.id })),
					"NOT_FOUND",
				);
				await expectCode(
					call(() => stranger().runNow({ jobSourceId: mine.id })),
					"NOT_FOUND",
				);
			}
			const [untouched] = (await owner.query(`select name from job_source where id = $1`, [mine.id])).rows;
			expect(untouched).toEqual({ name: "Alice only" });
		});
	});

	describe("runs and the review list", () => {
		let sourceId = "";

		it("runNow fetches, scores and saves, and answers with the counts", async () => {
			const created = await call(() =>
				alice().sources.create({
					...input,
					name: "Runs",
					boards: [
						{ source: "lever", token: "run-a" },
						{ source: "greenhouse", token: "run-b" },
					],
				}),
			);
			sourceId = created.id;
			const summary = await call(() => alice().runNow({ jobSourceId: sourceId }));
			expect(summary).toMatchObject({
				status: "succeeded",
				fetched: 6,
				new: 6,
				duplicate: 0,
				scored: 6,
				aiMatched: 0,
				errors: [],
			});
			const refreshed = (await call(() => alice().sources.list())).find((row) => row.id === sourceId);
			expect(refreshed?.lastRunAt).toBeInstanceOf(Date);
		});

		it("allows one runNow per automation every 10 minutes", async () => {
			await expectCode(
				call(() => alice().runNow({ jobSourceId: sourceId })),
				"TOO_MANY_REQUESTS",
			);
			await allowRunNow(sourceId);
			const summary = await call(() => alice().runNow({ jobSourceId: sourceId }));
			expect(summary).toMatchObject({ new: 0, duplicate: 6 });
		});

		it("lists the caller's jobs best match first, filtered by status, and pages", async () => {
			const all = await call(() => alice().jobs.list({ limit: 50, offset: 0 }));
			expect(all).toHaveLength(6);
			expect(all[0]?.title).toBe("Backend Engineer");
			const scores = all.map((job) => job.localScore);
			expect(scores).toEqual([...scores].sort((a, b) => b - a));
			expect(all.every((job) => job.status === "new" && job.url.startsWith("https://"))).toBe(true);

			const page = await call(() => alice().jobs.list({ limit: 2, offset: 2 }));
			expect(page.map((job) => job.id)).toEqual(all.slice(2, 4).map((job) => job.id));
			expect(await call(() => alice().jobs.list({ status: "dismissed", limit: 50, offset: 0 }))).toEqual([]);
		});

		it("does not show jobs to another user or organization", async () => {
			expect(await call(() => alice2().jobs.list({ limit: 50, offset: 0 }))).toEqual([]);
			expect(await call(() => bob().jobs.list({ limit: 50, offset: 0 }))).toEqual([]);
		});

		it("dismiss keeps the row, is idempotent, and the job never comes back after a re-run", async () => {
			const [first] = await call(() => alice().jobs.list({ limit: 1, offset: 0 }));
			if (!first) throw new Error("no job");
			const dismissed = await call(() => alice().jobs.dismiss({ id: first.id }));
			expect(dismissed.status).toBe("dismissed");
			expect((await call(() => alice().jobs.dismiss({ id: first.id }))).status).toBe("dismissed");
			expect(await call(() => alice().jobs.list({ status: "dismissed", limit: 50, offset: 0 }))).toHaveLength(1);

			await allowRunNow(sourceId);
			const summary = await call(() => alice().runNow({ jobSourceId: sourceId }));
			expect(summary.new).toBe(0);
			const stored = (await owner.query(`select status from discovered_job where id = $1`, [first.id])).rows[0];
			expect(stored).toEqual({ status: "dismissed" });
			expect(await call(() => alice().jobs.list({ status: "new", limit: 50, offset: 0 }))).toHaveLength(5);
		});

		it("dismissing an accepted job is a conflict, and a stranger's job is not found", async () => {
			const [target] = await call(() => alice().jobs.list({ status: "new", limit: 1, offset: 0 }));
			if (!target) throw new Error("no job");
			await owner.query(`update discovered_job set status = 'accepted' where id = $1`, [target.id]);
			await expectCode(
				call(() => alice().jobs.dismiss({ id: target.id })),
				"CONFLICT",
			);
			for (const stranger of [alice2, bob])
				await expectCode(
					call(() => stranger().jobs.dismiss({ id: target.id })),
					"NOT_FOUND",
				);
		});

		it("deleting an automation keeps its jobs and their status", async () => {
			await call(() => alice().sources.delete({ id: sourceId }));
			const kept = await call(() => alice().jobs.list({ limit: 50, offset: 0 }));
			expect(kept).toHaveLength(6);
			expect(kept.every((job) => job.jobSourceId === null)).toBe(true);
			expect(kept.filter((job) => job.status === "dismissed")).toHaveLength(1);
		});

		it("lets only one of two simultaneous runNow requests through", async () => {
			const created = await call(() =>
				alice().sources.create({ ...input, name: "Race", boards: [{ source: "lever", token: "race" }] }),
			);
			const results = await Promise.allSettled([
				call(() => alice().runNow({ jobSourceId: created.id })),
				call(() => alice().runNow({ jobSourceId: created.id })),
			]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
			expect(rejected.reason).toMatchObject({ code: "TOO_MANY_REQUESTS" });
			expect(
				(await owner.query(`select count(*)::int as n from discovery_run where job_source_id = $1`, [created.id]))
					.rows[0],
			).toEqual({ n: 1 });
		});
	});
});
