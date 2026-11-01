import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { createRouterClient } from "@orpc/server";
import { Pool } from "pg";
import { linkAnonymousAccount } from "@reactive-resume/auth/config";
import { getPool, withDatabasePool } from "@reactive-resume/db/client";
import { answerRouter } from "./answer-router";
import { careerRouter } from "./router";

// This suite needs the real organization scope, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());

// The scheduler tick below runs against the shared test database: no Trash purge, and a recorded briefing writer that
// fails for the applications named in `generated.failFor`.
const generated = vi.hoisted(() => ({ calls: [] as string[], failFor: new Set<string>() }));
vi.mock("./generate", () => ({
	generateCareer: vi.fn(async (input: { applicationId: string }) => {
		generated.calls.push(input.applicationId);
		if (generated.failFor.has(input.applicationId)) throw new Error("The provider failed.");
		return { item: null, answer: null };
	}),
}));
vi.mock("../documents/service", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../documents/service")>();
	return { documentsService: { ...actual.documentsService, purgeExpiredTrash: vi.fn(async () => undefined) } };
});

// P1-T07: career tenancy through the real routers, as the `careeros_app` role (NOBYPASSRLS), against the migrated
// public schema. Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const CAREER_TABLES = [
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
];

describe.skipIf(!configured)("career tables, the scheduler and tenant isolation", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `car-org-a-${run}`,
		orgB: `car-org-b-${run}`,
		orgG: `car-org-g-${run}`,
		orgT: `car-org-t-${run}`,
		userA: `car-user-a-${run}`,
		userB: `car-user-b-${run}`,
		// A member of both organizations: its own data in each is what separates the two.
		userAB: `car-user-ab-${run}`,
		guest: `car-guest-${run}`,
		guest2: `car-guest2-${run}`,
		target: `car-target-${run}`,
		appA: `car-app-a-${run}`,
		appBAB: `car-app-bab-${run}`,
		oppB: `car-opp-b-${run}`,
		noteB: `car-note-b-${run}`,
		factA: `car-fact-a-${run}`,
		role: `t07_noexec_${run}`,
		interview: `car-interview-${run}`,
		appSchedA: `car-sapp-a-${run}`,
		appSchedB: `car-sapp-b-${run}`,
	};
	let owner: Pool;
	// CAREEROS (P1-Q08): its own database, because this file runs the global career scheduler.
	let database: IsolatedTestDatabase;
	let app: Pool;

	const inApp = <T>(fn: () => T) => withDatabasePool(app, fn);
	const user = (id: string) => ({
		id,
		name: id,
		email: `${id}@example.test`,
		emailVerified: true,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	const context = (userId: string, activeOrganizationId: string) => ({
		locale: "en-US" as const,
		reqHeaders: new Headers(),
		resHeaders: new Headers(),
		authentication: {
			user: user(userId),
			method: "session" as const,
			permissions: ["read", "write", "delete"] as ("read" | "write" | "delete")[],
			activeOrganizationId,
		},
	});
	const careerFor = (userId: string, orgId: string) =>
		createRouterClient(careerRouter, { context: context(userId, orgId) });
	const answersFor = (userId: string, orgId: string) =>
		createRouterClient(answerRouter, { context: context(userId, orgId) });
	const rowCount = async (sql: string, params: unknown[] = []) =>
		Number((await owner.query<{ n: string }>(sql, params)).rows[0]?.n);
	const interviewEntry = (id: string) => ({
		id,
		type: "interview",
		at: new Date(Date.now() + 86_400_000).toISOString(),
		kind: "technical",
		durationMinutes: 60,
		location: "",
		notes: "",
		participants: [],
		audience: "other",
		timezone: "UTC",
	});
	const story = (title: string) => ({
		title,
		situation: "S",
		task: "T",
		action: "A",
		result: "R",
		reflection: "",
		factIds: [],
		tags: [],
		applicationId: null,
	});

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("career_tenancy");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		await owner.query(
			`INSERT INTO organization (id, name, slug) VALUES ($1, 'A', $1), ($2, 'B', $2), ($3, 'G', $3), ($4, 'T', $4)`,
			[ids.orgA, ids.orgB, ids.orgG, ids.orgT],
		);
		for (const id of [ids.userA, ids.userB, ids.userAB, ids.guest, ids.guest2, ids.target]) {
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username, is_anonymous) VALUES ($1, $1, $1 || '@example.test', $1, $1, $2)`,
				[id, id.startsWith("car-guest")],
			);
		}
		const members: [string, string, string, string][] = [
			["m-a", ids.orgA, ids.userA, "2026-01-01"],
			["m-b", ids.orgB, ids.userB, "2026-01-01"],
			["m-ab-a", ids.orgA, ids.userAB, "2026-01-01"],
			["m-ab-b", ids.orgB, ids.userAB, "2026-01-02"],
			["m-g", ids.orgG, ids.guest, "2026-01-01"],
			["m-g2", ids.orgG, ids.guest2, "2026-01-01"],
			["m-t", ids.orgT, ids.target, "2026-01-01"],
		];
		for (const [id, org, userId, createdAt] of members)
			await owner.query(
				`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'owner', $4)`,
				[`${id}-${run}`, org, userId, createdAt],
			);
		// Applications: A's own, and userAB's in organization B.
		await owner.query(
			`INSERT INTO application (id, organization_id, user_id, company, role) VALUES ($1, $2, $3, 'Secret Co', 'Spy'), ($4, $5, $6, 'AB in B', 'Engineer')`,
			[ids.appA, ids.orgA, ids.userA, ids.appBAB, ids.orgB, ids.userAB],
		);
		// Career rows of organization A (userA) and, for the cross-organization checks, of organization B (userB).
		await owner.query(
			`INSERT INTO career_profile (organization_id, user_id, data) VALUES ($1, $2, '{"targetRoles":["Secret role"]}')`,
			[ids.orgA, ids.userA],
		);
		await owner.query(
			`INSERT INTO career_fact (id, organization_id, user_id, text, category, source, source_key) VALUES ($1, $2, $3, 'Secret fact', 'skill', '{"kind":"manual","id":"x","quote":"x"}', $1)`,
			[ids.factA, ids.orgA, ids.userA],
		);
		await owner.query(`INSERT INTO career_story (id, organization_id, user_id, data) VALUES ($1, $2, $3, $4)`, [
			`car-story-a-${run}`,
			ids.orgA,
			ids.userA,
			JSON.stringify(story("Secret story")),
		]);
		await owner.query(
			`INSERT INTO career_workspace (application_id, organization_id, user_id, data) VALUES ($1, $2, $3, '{"answers":[],"checklist":[],"questions":[]}')`,
			[ids.appA, ids.orgA, ids.userA],
		);
		await owner.query(
			`INSERT INTO career_schedule (id, organization_id, user_id, kind, query, next_run_at) VALUES ($1, $2, $3, 'discovery', 'secret', now() + interval '1 day')`,
			[`car-sched-a-${run}`, ids.orgA, ids.userA],
		);
		await owner.query(
			`INSERT INTO career_opportunity (id, organization_id, user_id, url, snippet) VALUES ($1, $2, $3, 'https://example.test/b', 'In B')`,
			[ids.oppB, ids.orgB, ids.userAB],
		);
		await owner.query(
			`INSERT INTO career_notification (id, organization_id, user_id, key, notice) VALUES ($1, $2, $3, 'k', '{"type":"email-failed"}')`,
			[ids.noteB, ids.orgB, ids.userAB],
		);
		await owner.query(`CREATE ROLE "${ids.role}" NOLOGIN`);
	}, 30_000);

	afterAll(async () => {
		await owner?.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [
			[ids.orgA, ids.orgB, ids.orgG, ids.orgT],
		]);
		await owner?.query(`DELETE FROM "user" WHERE id = ANY($1::text[]) OR id LIKE 'iso-user-%'`, [
			[ids.userA, ids.userB, ids.userAB, ids.guest, ids.guest2, ids.target],
		]);
		await owner?.query(`DROP ROLE IF EXISTS "${ids.role}"`);
		await owner?.end();
		await app?.end();
		await database?.drop();
	});

	describe("two organizations", () => {
		it("show the other organization's user none of the first organization's career rows", async () => {
			const b = careerFor(ids.userB, ids.orgB);
			expect(await inApp(() => b.profile({}))).toMatchObject({ targetRoles: [] });
			expect((await inApp(() => b.facts({ all: true }))).map((fact) => fact.id)).not.toContain(ids.factA);
			expect(await inApp(() => b.stories({}))).toEqual([]);
			expect(await inApp(() => b.schedules({}))).toEqual([]);
			expect(await inApp(() => b.notifications({}))).toEqual([]);
			expect(await inApp(() => b.opportunities({}))).toEqual([]);
			const a = careerFor(ids.userA, ids.orgA);
			expect((await inApp(() => a.facts({ all: true }))).map((fact) => fact.id)).toContain(ids.factA);
			// The tenant column is not part of the API surface.
			expect((await inApp(() => a.facts({ all: true })))[0]).not.toHaveProperty("organizationId");
			expect((await inApp(() => a.schedules({})))[0]).not.toHaveProperty("organizationId");
		});

		it("gets NOT_FOUND or no effect for the first organization's rows on every id procedure", async () => {
			const b = careerFor(ids.userB, ids.orgB);
			await expect(inApp(() => b.workspace({ applicationId: ids.appA }))).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() => b.saveWorkspace({ applicationId: ids.appA, checklist: [1], expected: { checklist: [] } })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(inApp(() => b.updateFact({ id: ids.factA, text: "Hijacked" }))).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await inApp(() => b.forgetFact({ id: ids.factA })).catch(() => undefined);
			await inApp(() => b.deleteStory({ id: `car-story-a-${run}` }));
			const secret = await owner.query(`SELECT text, status FROM career_fact WHERE id = $1`, [ids.factA]);
			expect(secret.rows).toEqual([{ text: "Secret fact", status: "active" }]);
			expect(await rowCount(`SELECT count(*) AS n FROM career_story WHERE id = $1`, [`car-story-a-${run}`])).toBe(1);
			expect(await rowCount(`SELECT count(*) AS n FROM career_workspace WHERE application_id = $1`, [ids.appA])).toBe(
				1,
			);
		});

		it("keeps a separate career profile for the same user in each organization", async () => {
			const inA = careerFor(ids.userAB, ids.orgA);
			const inB = careerFor(ids.userAB, ids.orgB);
			await inApp(() => inA.saveProfile({ targetRoles: ["Role in A"], locations: [] } as never));
			expect((await inApp(() => inB.profile({}))).targetRoles, "nothing in B yet").toEqual([]);
			await inApp(() => inB.saveProfile({ targetRoles: ["Role in B"], locations: [] } as never));
			expect((await inApp(() => inA.profile({}))).targetRoles).toEqual(["Role in A"]);
			expect((await inApp(() => inB.profile({}))).targetRoles).toEqual(["Role in B"]);
			expect(await rowCount(`SELECT count(*) AS n FROM career_profile WHERE user_id = $1`, [ids.userAB])).toBe(2);
			await inApp(() => inA.saveProfile({ targetRoles: ["Role in A again"], locations: [] } as never));
			expect((await inApp(() => inB.profile({}))).targetRoles, "B is untouched").toEqual(["Role in B"]);
		});

		it("saves facts, stories, schedules, answers and workspaces into the active organization only", async () => {
			const inB = careerFor(ids.userAB, ids.orgB);
			const fact = await inApp(() =>
				inB.saveFact({
					text: "In B",
					category: "skill",
					source: { kind: "manual", id: "b", quote: "In B" },
					applicationId: ids.appBAB,
				}),
			);
			const saved = await inApp(() => inB.saveStory({ ...story("In B"), applicationId: ids.appBAB }));
			await inApp(() => inB.saveWorkspace({ applicationId: ids.appBAB, checklist: [1], expected: { checklist: [] } }));
			await inApp(() =>
				inB.saveSchedule({
					kind: "follow-up",
					applicationId: ids.appBAB,
					enabled: false,
					nextRunAt: new Date(Date.now() + 86_400_000),
					timezone: "UTC",
					query: "",
					interviewId: null,
					lead: null,
					email: false,
					intervalDays: null,
					aiProviderId: null,
				}),
			);
			for (const [table, id, column] of [
				["career_fact", fact?.id, "id"],
				["career_story", saved.id, "id"],
				["career_workspace", ids.appBAB, "application_id"],
			] as const)
				expect(
					await rowCount(`SELECT count(*) AS n FROM ${table} WHERE ${column} = $1 AND organization_id = $2`, [
						id,
						ids.orgB,
					]),
					table,
				).toBe(1);
			expect(
				await rowCount(`SELECT count(*) AS n FROM career_schedule WHERE application_id = $1 AND organization_id = $2`, [
					ids.appBAB,
					ids.orgB,
				]),
			).toBe(1);
			// The same user in organization A sees none of it.
			const inA = careerFor(ids.userAB, ids.orgA);
			expect((await inApp(() => inA.facts({ all: true }))).map((item) => item.id)).not.toContain(fact?.id);
			expect(await inApp(() => inA.schedules({}))).toEqual([]);
		});

		it("keeps saved answers per organization", async () => {
			const inB = answersFor(ids.userAB, ids.orgB);
			await inApp(() =>
				inB.save({
					applicationId: ids.appBAB,
					question: "Why us?",
					answer: "Because.",
					source: "manual",
					scope: "reusable",
					factIds: [],
					storyIds: [],
					expectedEvidence: [],
					reviewed: true,
					noEmployerWording: true,
				} as never),
			);
			expect(
				await rowCount(`SELECT count(*) AS n FROM career_answer WHERE user_id = $1 AND organization_id = $2`, [
					ids.userAB,
					ids.orgB,
				]),
			).toBe(1);
			await expect(
				inApp(() => answersFor(ids.userAB, ids.orgA).list({ applicationId: ids.appBAB })),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});
	});

	describe("links across organizations", () => {
		it("refuses another organization's application, role and notification by id", async () => {
			const inA = careerFor(ids.userAB, ids.orgA);
			const scope = { applicationId: ids.appBAB };
			await expect(
				inApp(() =>
					inA.saveFact({ text: "x", category: "skill", source: { kind: "manual", id: "x", quote: "x" }, ...scope }),
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(inApp(() => inA.saveStory({ ...story("x"), ...scope }))).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(inApp(() => inA.workspace(scope))).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() => inA.saveWorkspace({ ...scope, checklist: [1], expected: { checklist: [] } })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() =>
					inA.saveSchedule({
						kind: "follow-up",
						...scope,
						enabled: false,
						nextRunAt: new Date(Date.now() + 86_400_000),
						timezone: "UTC",
						query: "",
						interviewId: null,
						lead: null,
						email: false,
						intervalDays: null,
						aiProviderId: null,
					}),
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() =>
					answersFor(ids.userAB, ids.orgA).save({
						...scope,
						question: "Why?",
						answer: "x",
						source: "manual",
						scope: "reusable",
						factIds: [],
						storyIds: [],
						expectedEvidence: [],
						reviewed: true,
						noEmployerWording: true,
					} as never),
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(inApp(() => inA.trackOpportunity({ id: ids.oppB }))).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(inApp(() => inA.dismissOpportunity({ id: ids.oppB }))).rejects.toMatchObject({ code: "NOT_FOUND" });
			await inApp(() => inA.markNotificationRead({ id: ids.noteB }));
			const note = await owner.query(`SELECT read_at FROM career_notification WHERE id = $1`, [ids.noteB]);
			expect(note.rows).toEqual([{ read_at: null }]);
			const opp = await owner.query(
				`SELECT dismissed_at, tracked_application_id FROM career_opportunity WHERE id = $1`,
				[ids.oppB],
			);
			expect(opp.rows).toEqual([{ dismissed_at: null, tracked_application_id: null }]);
		});

		it("keeps a workspace in its application's organization (composite foreign key)", async () => {
			const bare = `car-app-fk-${run}`;
			await owner.query(
				`INSERT INTO application (id, organization_id, user_id, company, role) VALUES ($1, $2, $3, 'FK Co', 'Writer')`,
				[bare, ids.orgB, ids.userAB],
			);
			await expect(
				owner.query(
					`INSERT INTO career_workspace (application_id, organization_id, user_id, data) VALUES ($1, $2, $3, '{}')`,
					[bare, ids.orgA, ids.userAB],
				),
			).rejects.toMatchObject({ code: "23503" });
		});
	});

	describe("the account export", () => {
		it("covers the active organization only and leaves out the tenant column", async () => {
			const { careerService } = await import("./service");
			const { withOrgContext } = await import("@careeros/tenancy");
			const exported = await inApp(() => withOrgContext(ids.orgA, () => careerService.exportData(ids.userAB)));
			expect(exported.profile.targetRoles).toEqual(["Role in A again"]);
			expect(exported.opportunities).toEqual([]);
			expect(exported.workspaces).toEqual([]);
			const fromB = await inApp(() => withOrgContext(ids.orgB, () => careerService.exportData(ids.userAB)));
			expect(fromB.opportunities.map((row) => row.id)).toEqual([ids.oppB]);
			expect(fromB.opportunities[0]).not.toHaveProperty("organizationId");
			expect(fromB.workspaces[0]).not.toHaveProperty("organizationId");
		});
	});

	describe("the database", () => {
		it("serves no career row to careeros_app without an organization", async () => {
			for (const table of CAREER_TABLES)
				expect((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0], table).toEqual({ n: 0 });
		});

		it("refuses a write for another organization and a write without any organization", async () => {
			const { withOrgContext } = await import("@careeros/tenancy");
			const inserts: Record<string, (orgId: string) => string> = {
				career_profile: (org) =>
					`INSERT INTO career_profile (organization_id, user_id, data) VALUES ('${org}', '${ids.target}', '{}')`,
				career_fact: (org) =>
					`INSERT INTO career_fact (id, organization_id, user_id, text, category, source, source_key) VALUES ('x-${randomUUID()}', '${org}', '${ids.target}', 'x', 'skill', '{}', '${randomUUID()}')`,
				career_opportunity: (org) =>
					`INSERT INTO career_opportunity (id, organization_id, user_id, url, snippet) VALUES ('x-${randomUUID()}', '${org}', '${ids.target}', 'https://x.test/${randomUUID()}', 'x')`,
				career_answer: (org) =>
					`INSERT INTO career_answer (id, organization_id, user_id, question, answer, source, scope, employer, fact_ids, story_ids, evidence, reviewed_at, duplicate_key) VALUES ('x-${randomUUID()}', '${org}', '${ids.target}', 'q', 'a', 'manual', 'reusable', '', '[]', '[]', '[]', now(), '${randomUUID()}')`,
			};
			for (const [table, insert] of Object.entries(inserts)) {
				await expect(
					inApp(() => withOrgContext(ids.orgB, async () => getPool().query(insert(ids.orgA)))),
					`${table} for another organization`,
				).rejects.toMatchObject({ code: "42501" });
				await expect(
					inApp(() => app.query(insert(ids.orgB))),
					`${table} without an organization`,
				).rejects.toMatchObject({ code: "42501" });
			}
		});
	});

	describe("the scheduler", () => {
		const seedSchedule = async (orgId: string, userId: string, applicationId: string, scheduleId: string) => {
			await owner.query(
				`INSERT INTO application (id, organization_id, user_id, company, role, status, activity) VALUES ($1, $2, $3, 'Sched Co', 'Writer', 'interview', $4)`,
				[
					applicationId,
					orgId,
					userId,
					JSON.stringify([
						{ id: `${scheduleId}-s`, type: "stage", stage: "interview", at: new Date().toISOString() },
						interviewEntry(ids.interview),
					]),
				],
			);
			await owner.query(
				`INSERT INTO career_schedule (id, organization_id, user_id, application_id, interview_id, kind, lead, enabled, next_run_at) VALUES ($1, $2, $3, $4, $5, 'prepare', '24h', true, '1999-01-01')`,
				[scheduleId, orgId, userId, applicationId, ids.interview],
			);
		};

		it("lists due schedules, due jobs and upkeep as ids only, to careeros_app, and refuses a role without EXECUTE", async () => {
			await seedSchedule(ids.orgA, ids.userA, `list-${ids.appSchedA}`, `list-sched-a-${run}`);
			const orgs = await app.query(`SELECT careeros_orgs_with_due_career_schedules(now()) AS org`);
			expect(orgs.rows.map((row) => row.org)).toContain(ids.orgA);
			await owner.query(
				`INSERT INTO career_job (id, organization_id, user_id, schedule_id, due_at) VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
				[`list-job-${run}`, ids.orgA, ids.userA, `list-sched-a-${run}`],
			);
			const jobs = await app.query(`SELECT * FROM careeros_due_career_jobs(now(), 1000)`);
			expect(jobs.rows.find((row) => row.id === `list-job-${run}`)).toEqual({
				id: `list-job-${run}`,
				organization_id: ids.orgA,
			});
			expect(Object.keys(jobs.rows[0] ?? {}).sort()).toEqual(["id", "organization_id"]);
			expect((await app.query(`SELECT * FROM careeros_due_career_jobs(now(), 0)`)).rows).toEqual([]);
			await owner.query(`DELETE FROM career_schedule WHERE id = $1`, [`list-sched-a-${run}`]);
			await owner.query(`DELETE FROM application WHERE id = $1`, [`list-${ids.appSchedA}`]);

			const client = await owner.connect();
			try {
				await client.query(`SET ROLE "${ids.role}"`);
				for (const sql of [
					`SELECT careeros_due_career_jobs(now(), 5)`,
					`SELECT careeros_orgs_with_due_career_schedules(now())`,
					`SELECT careeros_orgs_with_career_upkeep(now())`,
					`SELECT careeros_move_guest_career('a', 'b', 'c')`,
				])
					await expect(client.query(sql), sql).rejects.toMatchObject({ code: "42501" });
			} finally {
				await client.query("RESET ROLE").catch(() => undefined);
				client.release();
			}
			// The interim T06 functions are gone.
			expect(
				await rowCount(
					`SELECT count(*) AS n FROM pg_proc WHERE proname IN ('careeros_application_is_open', 'careeros_application_org')`,
				),
			).toBe(0);
		});

		it("runs jobs of two organizations each under its own context, and a failure in one does not block the other", async () => {
			const { runCareerJobs } = await import("./jobs");
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				await seedSchedule(ids.orgA, ids.userA, ids.appSchedA, `car-sched-run-a-${run}`);
				await seedSchedule(ids.orgB, ids.userB, ids.appSchedB, `car-sched-run-b-${run}`);
				generated.failFor.add(ids.appSchedB);
				await inApp(() => runCareerJobs());
				expect(generated.calls).toEqual(expect.arrayContaining([ids.appSchedA, ids.appSchedB]));
				const jobs = await owner.query(
					`SELECT schedule_id, organization_id, user_id, status, attempts FROM career_job WHERE schedule_id = ANY($1::text[]) ORDER BY schedule_id`,
					[[`car-sched-run-a-${run}`, `car-sched-run-b-${run}`]],
				);
				expect(jobs.rows).toEqual([
					{
						schedule_id: `car-sched-run-a-${run}`,
						organization_id: ids.orgA,
						user_id: ids.userA,
						status: "completed",
						attempts: 1,
					},
					{
						schedule_id: `car-sched-run-b-${run}`,
						organization_id: ids.orgB,
						user_id: ids.userB,
						// Failed once: queued again after a delay, and the other organization's job ran regardless.
						status: "queued",
						attempts: 1,
					},
				]);
				// The briefing's notification landed in the job's own organization.
				const notes = await owner.query(
					`SELECT organization_id, application_id FROM career_notification WHERE application_id = ANY($1::text[])`,
					[[ids.appSchedA, ids.appSchedB]],
				);
				expect(notes.rows).toEqual([{ organization_id: ids.orgA, application_id: ids.appSchedA }]);
			} finally {
				generated.failFor.clear();
				errors.mockRestore();
			}
		});
	});

	describe("guest linking", () => {
		const seedGuest = async (guestId: string, label: string) => {
			const application = `car-guest-app-${label}-${run}`;
			const schedule = `car-guest-sched-${label}-${run}`;
			await owner.query(
				`INSERT INTO application (id, organization_id, user_id, company, role) VALUES ($1, $2, $3, 'Guest Co', 'Writer')`,
				[application, ids.orgG, guestId],
			);
			await owner.query(
				`INSERT INTO career_workspace (application_id, organization_id, user_id, data) VALUES ($1, $2, $3, '{"answers":[],"checklist":[],"questions":[]}')`,
				[application, ids.orgG, guestId],
			);
			await owner.query(
				`INSERT INTO career_fact (id, organization_id, user_id, application_id, text, category, source, source_key) VALUES ($1, $2, $3, $4, 'Linked fact', 'skill', '{}', $1)`,
				[`car-guest-fact-${label}-${run}`, ids.orgG, guestId, application],
			);
			await owner.query(
				`INSERT INTO career_fact (id, organization_id, user_id, text, category, source, source_key) VALUES ($1, $2, $3, 'General fact', 'skill', '{}', $1)`,
				[`car-guest-general-${label}-${run}`, ids.orgG, guestId],
			);
			await owner.query(
				`INSERT INTO career_schedule (id, organization_id, user_id, application_id, kind, enabled, next_run_at) VALUES ($1, $2, $3, $4, 'follow-up', false, now())`,
				[schedule, ids.orgG, guestId, application],
			);
			await owner.query(
				`INSERT INTO career_job (id, organization_id, user_id, schedule_id, due_at) VALUES ($1, $2, $3, $4, now())`,
				[`car-guest-job-${label}-${run}`, ids.orgG, guestId, schedule],
			);
			await owner.query(
				`INSERT INTO career_answer (id, organization_id, user_id, question, answer, source, scope, employer, fact_ids, story_ids, evidence, reviewed_at, duplicate_key)
				 VALUES ($1, $2, $3, 'q', 'a', 'manual', 'reusable', '', '[]', '[]', '[]', now(), $4)`,
				[`car-guest-answer-${label}-${run}`, ids.orgG, guestId, `dup-${label}-${run}`],
			);
			return { application, schedule };
		};

		it("moves a guest's answers and application-linked career rows to the account's organization", async () => {
			const { application, schedule } = await seedGuest(ids.guest, "one");
			await inApp(() => linkAnonymousAccount({ fromUserId: ids.guest, toUserId: ids.target }));
			const moved = (table: string, key: string, id: string) =>
				owner.query(`SELECT user_id, organization_id FROM ${table} WHERE ${key} = $1`, [id]);
			const expected = [{ user_id: ids.target, organization_id: ids.orgT }];
			expect((await moved("application", "id", application)).rows).toEqual(expected);
			expect((await moved("career_workspace", "application_id", application)).rows).toEqual(expected);
			expect((await moved("career_fact", "id", `car-guest-fact-one-${run}`)).rows).toEqual(expected);
			expect((await moved("career_schedule", "id", schedule)).rows).toEqual(expected);
			expect((await moved("career_job", "id", `car-guest-job-one-${run}`)).rows).toEqual(expected);
			expect((await moved("career_answer", "id", `car-guest-answer-one-${run}`)).rows).toEqual(expected);
			// Knowledge that is not tied to an application stays with the guest, as before.
			expect((await moved("career_fact", "id", `car-guest-general-one-${run}`)).rows).toEqual([
				{ user_id: ids.guest, organization_id: ids.orgG },
			]);
		});

		it("refuses the same saved answer on both sides, and a source that is not a guest", async () => {
			await seedGuest(ids.guest2, "two");
			await owner.query(
				`INSERT INTO career_answer (id, organization_id, user_id, question, answer, source, scope, employer, fact_ids, story_ids, evidence, reviewed_at, duplicate_key)
				 VALUES ($1, $2, $3, 'q', 'a', 'manual', 'reusable', '', '[]', '[]', '[]', now(), $4)`,
				[`car-target-answer-${run}`, ids.orgT, ids.target, `dup-two-${run}`],
			);
			await expect(
				inApp(() => linkAnonymousAccount({ fromUserId: ids.guest2, toUserId: ids.target })),
			).rejects.toMatchObject({ body: { message: expect.stringContaining("duplicate saved application answers") } });
			expect(await rowCount(`SELECT count(*) AS n FROM career_answer WHERE user_id = $1`, [ids.guest2])).toBe(1);
			await expect(
				inApp(() => linkAnonymousAccount({ fromUserId: ids.userA, toUserId: ids.target })),
			).rejects.toBeDefined();
			expect(await rowCount(`SELECT count(*) AS n FROM career_workspace WHERE user_id = $1`, [ids.userA])).toBe(1);
		});
	});
});
