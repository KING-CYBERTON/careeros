import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { isolationRegistry, runApiIsolationCheck } from "@careeros/isolation-testing";
import { createRouterClient } from "@orpc/server";
import { Pool } from "pg";
import { linkAnonymousAccount } from "@reactive-resume/auth/config";
import { getPool, withDatabasePool } from "@reactive-resume/db/client";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { applicationProfileRouter } from "../application-profile/router";
import { coverLettersRouter } from "../cover-letters/router";
import { documentsRouter } from "../documents/router";
import { applicationsRouter } from "./router";

// This suite needs the real organization scope, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());

// The scheduler tick below runs against the shared test database: no Trash purge, and a recorded briefing writer.
const generated = vi.hoisted(() => ({ calls: [] as { applicationId: string }[] }));
vi.mock("../career/generate", () => ({
	generateCareer: vi.fn(async (input: { applicationId: string }) => {
		generated.calls.push({ applicationId: input.applicationId });
		return { item: null, answer: null };
	}),
}));
vi.mock("../documents/service", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../documents/service")>();
	return { documentsService: { ...actual.documentsService, purgeExpiredTrash: vi.fn(async () => undefined) } };
});

// P1-T06: application tenancy through the real routers, as the `careeros_app` role (NOBYPASSRLS), against the migrated
// public schema. Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("applications, lanes, pipelines, profiles and tenant isolation", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `app-org-a-${run}`,
		orgB: `app-org-b-${run}`,
		orgG: `app-org-g-${run}`,
		orgT: `app-org-t-${run}`,
		userA: `app-user-a-${run}`,
		userB: `app-user-b-${run}`,
		// A member of both organizations: its own data in each is what separates the two.
		userAB: `app-user-ab-${run}`,
		guest: `app-guest-${run}`,
		guest2: `app-guest2-${run}`,
		guest3: `app-guest3-${run}`,
		target: `app-target-${run}`,
		appA: `app-a-${run}`,
		appAB: `app-ab-${run}`,
		appBAB: `app-bab-${run}`,
		laneA: `lane-a-${run}`,
		resumeA: `app-res-a-${run}`,
		resumeB: `app-res-b-${run}`,
		resumeAB: `app-res-ab-${run}`,
		resumeABInB: `app-res-ab-b-${run}`,
		letterABInB: `app-letter-ab-b-${run}`,
		role: `t06_noexec_${run}`,
		schedule: `app-sched-${run}`,
		interview: `app-interview-${run}`,
	};
	let owner: Pool;
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
	const applicationsFor = (userId: string, orgId: string) =>
		createRouterClient(applicationsRouter, { context: context(userId, orgId) });
	const profileFor = (userId: string, orgId: string) =>
		createRouterClient(applicationProfileRouter, { context: context(userId, orgId) });
	const lettersFor = (userId: string, orgId: string) =>
		createRouterClient(coverLettersRouter, { context: context(userId, orgId) });
	const documentsFor = (userId: string, orgId: string) =>
		createRouterClient(documentsRouter, { context: context(userId, orgId) });
	const rowCount = async (sql: string, params: unknown[] = []) =>
		Number((await owner.query<{ n: string }>(sql, params)).rows[0]?.n);
	const profileData = { givenName: "Ada" };

	beforeAll(async () => {
		owner = new Pool({ connectionString: process.env.CAREEROS_TEST_DATABASE_URL });
		app = new Pool({ connectionString: process.env.CAREEROS_TEST_APP_DATABASE_URL });
		await owner.query(
			`INSERT INTO organization (id, name, slug) VALUES ($1, 'A', $1), ($2, 'B', $2), ($3, 'G', $3), ($4, 'T', $4)`,
			[ids.orgA, ids.orgB, ids.orgG, ids.orgT],
		);
		for (const id of [ids.userA, ids.userB, ids.userAB, ids.guest, ids.guest2, ids.guest3, ids.target]) {
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username, is_anonymous) VALUES ($1, $1, $1 || '@example.test', $1, $1, $2)`,
				[id, id.startsWith("app-guest")],
			);
		}
		// userAB joined organization A first, so it is its oldest organization.
		const members: [string, string, string, string][] = [
			["m-a", ids.orgA, ids.userA, "2026-01-01"],
			["m-b", ids.orgB, ids.userB, "2026-01-01"],
			["m-ab-a", ids.orgA, ids.userAB, "2026-01-01"],
			["m-ab-b", ids.orgB, ids.userAB, "2026-01-02"],
			["m-g", ids.orgG, ids.guest, "2026-01-01"],
			["m-g2", ids.orgG, ids.guest2, "2026-01-01"],
			["m-g3", ids.orgG, ids.guest3, "2026-01-01"],
			["m-t", ids.orgT, ids.target, "2026-01-01"],
		];
		for (const [id, org, userId, createdAt] of members)
			await owner.query(
				`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'owner', $4)`,
				[`${id}-${run}`, org, userId, createdAt],
			);
		const data = JSON.stringify(defaultResumeData);
		for (const [id, userId, orgId] of [
			[ids.resumeA, ids.userA, ids.orgA],
			[ids.resumeB, ids.userB, ids.orgB],
			[ids.resumeAB, ids.userAB, ids.orgA],
			[ids.resumeABInB, ids.userAB, ids.orgB],
		] as const)
			await owner.query(
				`INSERT INTO resume (id, name, slug, data, user_id, organization_id) VALUES ($1, $1, $1, $2, $3, $4)`,
				[id, data, userId, orgId],
			);
		// The lane trigger seeds the pipeline and the default lanes of each organization.
		await owner.query(`INSERT INTO application_pipeline (organization_id, user_id) VALUES ($1, $2), ($3, $4)`, [
			ids.orgA,
			ids.userA,
			ids.orgB,
			ids.userB,
		]);
		await owner.query(
			`INSERT INTO application_lane (id, organization_id, user_id, category, label, color, position) VALUES ($1, $2, $3, 'interview', 'Technical', '#123456', 10)`,
			[ids.laneA, ids.orgA, ids.userA],
		);
		await owner.query(
			`INSERT INTO application (id, organization_id, user_id, company, role, status, lane_id, activity) VALUES ($1, $2, $3, 'Secret Co', 'Spy', 'interview', $4, $5)`,
			[
				ids.appA,
				ids.orgA,
				ids.userA,
				ids.laneA,
				JSON.stringify([
					{ id: "stage-1", type: "stage", stage: "interview", at: new Date().toISOString(), laneId: ids.laneA },
					{
						id: ids.interview,
						type: "interview",
						at: new Date(Date.now() + 86_400_000).toISOString(),
						kind: "technical",
						durationMinutes: 60,
						location: "",
						notes: "",
						participants: [],
						audience: "other",
						timezone: "UTC",
					},
				]),
			],
		);
		await owner.query(
			`INSERT INTO application (id, organization_id, user_id, company, role) VALUES ($1, $2, $3, 'AB in A', 'Engineer'), ($4, $5, $3, 'AB in B', 'Engineer')`,
			[ids.appAB, ids.orgA, ids.userAB, ids.appBAB, ids.orgB],
		);
		await owner.query(
			`INSERT INTO application_profile (organization_id, user_id, data, reviewed_at, revision) VALUES ($1, $2, $3, now(), 'rev-a')`,
			[ids.orgA, ids.userA, JSON.stringify({ givenName: "Secret" })],
		);
		const style = JSON.stringify({
			basics: defaultResumeData.basics,
			picture: defaultResumeData.picture,
			metadata: defaultResumeData.metadata,
			sectionId: "cover-letter-section",
			itemId: "cover-letter-item",
		});
		await owner.query(
			`INSERT INTO cover_letter (id, name, style, user_id, organization_id) VALUES ($1, 'AB letter in B', $2, $3, $4)`,
			[ids.letterABInB, style, ids.userAB, ids.orgB],
		);
		await owner.query(`CREATE ROLE "${ids.role}" NOLOGIN`);
	}, 30_000);

	afterAll(async () => {
		await owner?.query(`DELETE FROM career_schedule WHERE id = $1`, [ids.schedule]);
		await owner?.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [
			[ids.orgA, ids.orgB, ids.orgG, ids.orgT],
		]);
		await owner?.query(`DELETE FROM "user" WHERE id = ANY($1::text[]) OR id LIKE 'iso-user-%'`, [
			[ids.userA, ids.userB, ids.userAB, ids.guest, ids.guest2, ids.guest3, ids.target],
		]);
		await owner?.query(`DROP ROLE IF EXISTS "${ids.role}"`);
		await owner?.end();
		await app?.end();
	});

	describe("the other organization's user", () => {
		it("gets NOT_FOUND for the first organization's application on every application procedure, and nothing changes", async () => {
			const b = applicationsFor(ids.userB, ids.orgB);
			const id = ids.appA;
			const file = new File([new Uint8Array([37, 80, 68, 70])], "a.pdf", { type: "application/pdf" });
			const calls: [string, () => Promise<unknown>][] = [
				["getById", () => b.getById({ id })],
				["update", () => b.update({ id, company: "Hijacked" })],
				["attachDocument", () => b.attachDocument({ id, kind: "resume", file })],
				["removeDocument", () => b.removeDocument({ id, kind: "resume" })],
				["addNote", () => b.addNote({ id, text: "Hijacked" })],
				["addInterview", () => b.addInterview({ id, at: new Date().toISOString(), kind: "technical" })],
				["updateInterview", () => b.updateInterview({ id, entryId: ids.interview, location: "Hijacked" })],
				["updateTimelineEntry", () => b.updateTimelineEntry({ id, entryId: "stage-1", text: "Hijacked" })],
				["deleteTimelineEntry", () => b.deleteTimelineEntry({ id, entryId: "stage-1" })],
				["delete", () => b.delete({ id })],
				["ai.matchScore", () => b.ai.matchScore({ id })],
				["ai.draftMessage", () => b.ai.draftMessage({ id, kind: "follow-up" })],
				["ai.tailorResume", () => b.ai.tailorResume({ id })],
			];
			for (const [name, call] of calls) {
				await expect(inApp(call), name).rejects.toMatchObject({ code: "NOT_FOUND" });
			}

			// The bulk procedures skip what they cannot see instead of failing.
			await expect(inApp(() => b.bulkUpdate({ ids: [id], status: "applied" }))).resolves.toEqual({ updated: 0 });
			await expect(inApp(() => b.bulkDelete({ ids: [id] }))).resolves.toEqual({ deleted: 0 });

			const { rows } = await owner.query(
				`SELECT company, status, lane_id, jsonb_array_length(activity) AS n FROM application WHERE id = $1`,
				[id],
			);
			expect(rows).toEqual([{ company: "Secret Co", status: "interview", lane_id: ids.laneA, n: 2 }]);
		});

		it("lists, counts and tags only its own applications", async () => {
			const b = applicationsFor(ids.userB, ids.orgB);
			await inApp(() => b.create({ company: "B Co", role: "Writer", tags: ["b-only"] }));
			const listed = await inApp(() => b.list({}));
			expect(listed.map((item) => item.company)).toEqual(["B Co"]);
			const summary = await inApp(() => b.listSummary({}));
			expect(summary.map((item) => item.company)).toEqual(["B Co"]);
			expect((await inApp(() => b.stats({}))).total).toBe(1);
			expect(await inApp(() => b.tags({}))).toEqual(["b-only"]);
			expect(await inApp(() => b.priorNoResponse({ company: "Secret Co" }))).toEqual([]);
			const a = await inApp(() => applicationsFor(ids.userA, ids.orgA).list({}));
			expect(a.map((item) => item.id)).toContain(ids.appA);
			// The tenant column is not part of the API surface.
			expect(a[0]).not.toHaveProperty("organizationId");
		});

		it("gets NOT_FOUND for the first organization's lane, and cannot use it", async () => {
			const b = applicationsFor(ids.userB, ids.orgB);
			const pipeline = await inApp(() => b.lanes.get({}));
			expect(pipeline.lanes.map((lane) => lane.id)).not.toContain(ids.laneA);
			const expectedRevision = pipeline.revision;
			const replacementId = pipeline.lanes.find((lane) => lane.systemKey === "interview")?.id ?? "";
			await expect(
				inApp(() => b.lanes.update({ id: ids.laneA, expectedRevision, label: "Hijacked" })),
				"lanes.update",
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() => b.lanes.retire({ id: ids.laneA, replacementId, expectedRevision })),
				"lanes.retire",
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			// reorder names every lane of the caller's own pipeline; A's lane is not part of it.
			await expect(
				inApp(() => b.lanes.reorder({ expectedRevision, ids: [ids.laneA] })),
				"lanes.reorder",
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			// An application cannot be put in it either.
			await expect(
				inApp(() => b.create({ company: "Stolen lane", role: "Writer", laneId: ids.laneA })),
				"create with A's lane",
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(await rowCount(`SELECT count(*) AS n FROM application WHERE company = 'Stolen lane'`)).toBe(0);
			const { rows } = await owner.query(
				`SELECT label, retired_at, position FROM application_lane WHERE organization_id = $1 AND id = $2`,
				[ids.orgA, ids.laneA],
			);
			expect(rows).toEqual([{ label: "Technical", retired_at: null, position: 10 }]);
		});

		it("has its own pipeline and profile, which never show the first organization's", async () => {
			const pipelineA = await inApp(() => applicationsFor(ids.userA, ids.orgA).lanes.get({}));
			expect(pipelineA.lanes.map((lane) => lane.id)).toContain(ids.laneA);
			expect(await inApp(() => profileFor(ids.userA, ids.orgA).get({})), "the owner reads its profile").toMatchObject({
				revision: "rev-a",
			});

			const profile = profileFor(ids.userB, ids.orgB);
			expect(await inApp(() => profile.get({})), "B has no profile").toBeNull();
			// A's revision means nothing to B, whose own profile does not exist.
			await expect(
				inApp(() => profile.save({ data: profileData as never, expectedRevision: "rev-a" })),
			).rejects.toMatchObject({ code: "CONFLICT" });
			await inApp(() => profile.delete({ expectedRevision: "rev-a" }));
			const { rows } = await owner.query(
				`SELECT revision, data->>'givenName' AS name FROM application_profile WHERE organization_id = $1 AND user_id = $2`,
				[ids.orgA, ids.userA],
			);
			expect(rows).toEqual([{ revision: "rev-a", name: "Secret" }]);
			expect(await rowCount(`SELECT count(*) AS n FROM application_profile WHERE user_id = $1`, [ids.userB])).toBe(0);
		});
	});

	describe("a user in two organizations", () => {
		it("has a separate pipeline in each, and switching the active organization switches it", async () => {
			const inA = applicationsFor(ids.userAB, ids.orgA);
			const inB = applicationsFor(ids.userAB, ids.orgB);
			const before = await inApp(() => inB.lanes.get({}));
			const startA = await inApp(() => inA.lanes.get({}));
			expect(before.lanes).toHaveLength(6);
			expect(startA.lanes).toHaveLength(6);

			const created = await inApp(() =>
				inA.lanes.create({
					expectedRevision: startA.revision,
					label: "Only in A",
					category: "saved",
					color: "#123456",
				}),
			);
			expect(created.revision).toBe(startA.revision + 1);
			expect(created.lanes).toHaveLength(7);

			const afterB = await inApp(() => inB.lanes.get({}));
			expect(afterB.lanes).toHaveLength(6);
			expect(afterB.revision).toBe(before.revision);
			expect(afterB.lanes.map((lane) => lane.label)).not.toContain("Only in A");
			// The same default lane id exists in both organizations, as two rows.
			const saved = `application-lane:${ids.userAB}:saved`;
			expect(
				await rowCount(
					`SELECT count(*) AS n FROM application_lane WHERE id = $1 AND organization_id = ANY($2::text[])`,
					[saved, [ids.orgA, ids.orgB]],
				),
			).toBe(2);
			expect(await rowCount(`SELECT count(*) AS n FROM application_pipeline WHERE user_id = $1`, [ids.userAB])).toBe(2);

			// Applications follow the active organization as well.
			expect((await inApp(() => inA.list({}))).map((item) => item.id)).toEqual([ids.appAB]);
			expect((await inApp(() => inB.list({}))).map((item) => item.id)).toEqual([ids.appBAB]);
			const created2 = await inApp(() => inB.create({ company: "New in B", role: "Writer" }));
			const row = await owner.query(`SELECT organization_id FROM application WHERE id = $1`, [created2]);
			expect(row.rows).toEqual([{ organization_id: ids.orgB }]);
		});

		it("has a separate application profile in each organization", async () => {
			const inA = profileFor(ids.userAB, ids.orgA);
			const inB = profileFor(ids.userAB, ids.orgB);
			expect(await inApp(() => inA.get({}))).toBeNull();
			const savedA = await inApp(() => inA.save({ data: { givenName: "In A" } as never, expectedRevision: null }));
			expect(await inApp(() => inB.get({})), "nothing in B yet").toBeNull();
			const savedB = await inApp(() => inB.save({ data: { givenName: "In B" } as never, expectedRevision: null }));
			expect((await inApp(() => inA.get({})))?.data.givenName).toBe("In A");
			expect((await inApp(() => inB.get({})))?.data.givenName).toBe("In B");
			expect(savedA.revision).not.toBe(savedB.revision);
			// An update in one organization conflicts only with that organization's revision.
			await expect(
				inApp(() => inB.save({ data: { givenName: "x" } as never, expectedRevision: savedA.revision })),
			).rejects.toMatchObject({ code: "CONFLICT" });
			await inApp(() => inB.delete({ expectedRevision: savedB.revision }));
			expect(await inApp(() => inB.get({}))).toBeNull();
			expect((await inApp(() => inA.get({})))?.data.givenName, "A is untouched").toBe("In A");
		});
	});

	describe("links across organizations", () => {
		it("refuses an application's resume from another organization", async () => {
			const inA = applicationsFor(ids.userAB, ids.orgA);
			// The same owner, so only the organization separates them.
			await expect(
				inApp(() => inA.create({ company: "Linked", role: "Writer", resumeId: ids.resumeABInB })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(inApp(() => inA.update({ id: ids.appAB, resumeId: ids.resumeABInB }))).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(await rowCount(`SELECT count(*) AS n FROM application WHERE company = 'Linked'`)).toBe(0);
			expect(await rowCount(`SELECT count(*) AS n FROM application WHERE resume_id = $1`, [ids.resumeABInB])).toBe(0);
			// Its own organization's resume works.
			await inApp(() => inA.update({ id: ids.appAB, resumeId: ids.resumeAB }));
			expect(
				await rowCount(`SELECT count(*) AS n FROM application WHERE id = $1 AND resume_id = $2`, [
					ids.appAB,
					ids.resumeAB,
				]),
			).toBe(1);
		});

		it("refuses a cover letter's source application from another organization", async () => {
			const inB = lettersFor(ids.userAB, ids.orgB);
			await expect(inApp(() => inB.create({ name: "Cross", applicationId: ids.appAB }))).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			const letter = await inApp(() => inB.getById({ id: ids.letterABInB }));
			await expect(
				inApp(() => inB.update({ id: ids.letterABInB, expectedRevision: letter.revision, applicationId: ids.appAB })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(
				await rowCount(`SELECT count(*) AS n FROM cover_letter WHERE source_application_id = $1`, [ids.appAB]),
			).toBe(0);
			// An application of its own organization works.
			await inApp(() =>
				inB.update({ id: ids.letterABInB, expectedRevision: letter.revision, applicationId: ids.appBAB }),
			);
			expect(
				await rowCount(`SELECT count(*) AS n FROM cover_letter WHERE id = $1 AND source_application_id = $2`, [
					ids.letterABInB,
					ids.appBAB,
				]),
			).toBe(1);
		});

		it("refuses a resume's application from another organization", async () => {
			const inB = documentsFor(ids.userAB, ids.orgB);
			await expect(
				inApp(() => inB.linkApplication({ type: "resume", id: ids.resumeABInB, applicationId: ids.appAB })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() => inB.copyForJob({ resumeId: ids.resumeABInB, applicationId: ids.appAB })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() => inB.linkApplication({ type: "letter", id: ids.letterABInB, applicationId: ids.appAB })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(await rowCount(`SELECT count(*) AS n FROM resume WHERE application_id = $1`, [ids.appAB])).toBe(0);
			await inApp(() => inB.linkApplication({ type: "resume", id: ids.resumeABInB, applicationId: ids.appBAB }));
			expect(
				await rowCount(`SELECT count(*) AS n FROM resume WHERE id = $1 AND application_id = $2`, [
					ids.resumeABInB,
					ids.appBAB,
				]),
			).toBe(1);
		});
	});

	describe("the isolation suite's API check", () => {
		it("passes for the four application tables", async () => {
			const b = applicationsFor(ids.userB, ids.orgB);
			const pb = profileFor(ids.userB, ids.orgB);
			const statusOf = async (call: () => Promise<unknown>) => {
				try {
					await inApp(call);
					return 200;
				} catch (error) {
					return (error as { status?: number }).status ?? 500;
				}
			};
			const entryFor = (table: string) => {
				const entry = isolationRegistry.find((candidate) => candidate.table === table);
				if (!entry) throw new Error(`${table} is not registered`);
				return entry;
			};
			const context = { owner, orgA: ids.orgA, orgB: ids.orgB };

			const application = await runApiIsolationCheck(
				{
					...entryFor("application"),
					api: {
						get: async (_session, id) => ({ status: await statusOf(() => b.getById({ id })) }),
						list: async () => ({ status: 200, ids: (await inApp(() => b.list({}))).map((item) => item.id) }),
					},
				},
				context,
			);
			expect(application.failures).toEqual([]);

			// A lane is reached through the pipeline update, which looks it up in the caller's own pipeline.
			const lane = await runApiIsolationCheck(
				{
					...entryFor("application_lane"),
					api: {
						get: async (_session, id) => {
							const { revision } = await inApp(() => b.lanes.get({}));
							return { status: await statusOf(() => b.lanes.update({ id, expectedRevision: revision, label: "x" })) };
						},
						list: async () => ({
							status: 200,
							ids: (await inApp(() => b.lanes.get({}))).lanes.map((item) => item.id),
						}),
					},
				},
				context,
			);
			expect(lane.failures).toEqual([]);

			// A pipeline belongs to its owner; the seed's marker lane tells whether it reached the other organization.
			const pipeline = await runApiIsolationCheck(
				{
					...entryFor("application_pipeline"),
					api: {
						get: async (_session, ownerId) => {
							const { lanes } = await inApp(() => b.lanes.get({}));
							return { status: lanes.some((item) => item.id === `application-lane:${ownerId}:saved`) ? 200 : 404 };
						},
						list: async () => ({
							status: 200,
							ids: (await inApp(() => b.lanes.get({}))).lanes.map((item) => item.id.split(":")[1] ?? ""),
						}),
					},
				},
				context,
			);
			expect(pipeline.failures).toEqual([]);

			// The seed's profile revision is its owner's id, so a leak shows as that revision.
			const profile = await runApiIsolationCheck(
				{
					...entryFor("application_profile"),
					api: {
						get: async (_session, ownerId) => ({
							status: (await inApp(() => pb.get({})))?.revision === ownerId ? 200 : 404,
						}),
						list: async () => {
							const stored = await inApp(() => pb.get({}));
							return { status: 200, ids: stored ? [stored.revision] : [] };
						},
					},
				},
				context,
			);
			expect(profile.failures).toEqual([]);
		});
	});

	describe("the database", () => {
		it("refuses a write for another organization and a write without any organization", async () => {
			const { withOrgContext } = await import("@careeros/tenancy");
			const inserts = {
				application: (orgId: string) =>
					`INSERT INTO application (id, organization_id, user_id, company, role) VALUES ('x-${randomUUID()}', '${orgId}', '${ids.userB}', 'X', 'X')`,
				application_lane: (orgId: string) =>
					`INSERT INTO application_lane (id, organization_id, user_id, category, color, position) VALUES ('x-${randomUUID()}', '${orgId}', '${ids.userB}', 'saved', '#123456', 99)`,
				application_pipeline: (orgId: string) =>
					`INSERT INTO application_pipeline (organization_id, user_id) VALUES ('${orgId}', '${ids.target}')`,
				application_profile: (orgId: string) =>
					`INSERT INTO application_profile (organization_id, user_id, data, reviewed_at, revision) VALUES ('${orgId}', '${ids.target}', '{}', now(), 'x')`,
			};
			for (const [table, insert] of Object.entries(inserts)) {
				await expect(
					inApp(() => withOrgContext(ids.orgB, async () => getPool().query(insert(ids.orgA)))),
					`${table} for another organization`,
				).rejects.toMatchObject({ code: "42501" });
				await expect(
					inApp(() => app.query(insert(ids.orgB))),
					`${table} without an organization`,
				).rejects.toMatchObject({
					code: "42501",
				});
			}
			expect(await rowCount(`SELECT count(*) AS n FROM application WHERE company = 'X'`)).toBe(0);
			expect(await rowCount(`SELECT count(*) AS n FROM application_lane WHERE position = 99`)).toBe(0);
			expect(await rowCount(`SELECT count(*) AS n FROM application_pipeline WHERE user_id = $1`, [ids.target])).toBe(0);
			expect(await rowCount(`SELECT count(*) AS n FROM application_profile WHERE user_id = $1`, [ids.target])).toBe(0);
		});

		it("serves rows only to the matching organization and none without one", async () => {
			for (const table of ["application", "application_lane", "application_pipeline", "application_profile"]) {
				expect((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0], table).toEqual({ n: 0 });
			}
			const { withOrgContext } = await import("@careeros/tenancy");
			const own = await inApp(() =>
				withOrgContext(ids.orgA, async () => getPool().query(`SELECT id FROM application ORDER BY id`)),
			);
			expect(own.rows.map((row) => row.id)).toContain(ids.appA);
			expect(own.rows.map((row) => row.id)).not.toContain(ids.appBAB);
		});

		it("keeps the lane foreign key inside the organization", async () => {
			// A's custom lane cannot be referenced by an application of the same user in another organization.
			await expect(
				owner.query(
					`INSERT INTO application (id, organization_id, user_id, company, role, status, lane_id) VALUES ($1, $2, $3, 'Cross lane', 'x', 'interview', $4)`,
					[`x-${randomUUID()}`, ids.orgB, ids.userA, ids.laneA],
				),
			).rejects.toBeDefined();
		});
	});

	describe("guest linking", () => {
		const seedGuest = async (guestId: string, label: string) => {
			const lane = `guest-lane-${label}-${run}`;
			const application = `guest-app-${label}-${run}`;
			await owner.query(`INSERT INTO application_pipeline (organization_id, user_id, revision) VALUES ($1, $2, 3)`, [
				ids.orgG,
				guestId,
			]);
			await owner.query(
				`INSERT INTO application_lane (id, organization_id, user_id, category, label, color, position) VALUES ($1, $2, $3, 'interview', 'Guest lane', '#654321', 10)`,
				[lane, ids.orgG, guestId],
			);
			await owner.query(
				`INSERT INTO application (id, organization_id, user_id, company, role, status, lane_id, activity, resume_file_url) VALUES ($1, $2, $3, 'Guest Co', 'Writer', 'interview', $4, $5, $6)`,
				[
					application,
					ids.orgG,
					guestId,
					lane,
					JSON.stringify([{ id: "s1", type: "stage", stage: "interview", at: new Date().toISOString(), laneId: lane }]),
					`/uploads/${guestId}/pictures/a.pdf`,
				],
			);
			return { lane, application };
		};

		it("moves a guest's pipeline, lanes, applications and profile to the account's organization", async () => {
			const { lane, application } = await seedGuest(ids.guest, "one");
			await owner.query(
				`INSERT INTO application_profile (organization_id, user_id, data, reviewed_at, revision) VALUES ($1, $2, '{}', now(), 'guest-rev')`,
				[ids.orgG, ids.guest],
			);
			await inApp(() => linkAnonymousAccount({ fromUserId: ids.guest, toUserId: ids.target }));

			const moved = await owner.query<{
				user_id: string;
				organization_id: string;
				lane_id: string;
				activity: { laneId: string }[];
				resume_file_url: string;
			}>(`SELECT user_id, organization_id, lane_id, activity, resume_file_url FROM application WHERE id = $1`, [
				application,
			]);
			expect(moved.rows).toHaveLength(1);
			const row = moved.rows[0];
			expect(row).toMatchObject({ user_id: ids.target, organization_id: ids.orgT });
			expect(row?.resume_file_url).toBe(`/uploads/${ids.target}/pictures/a.pdf`);
			// The custom lane was copied into the account's organization, and the history points at the copy.
			expect(row?.lane_id).not.toBe(lane);
			expect(row?.activity[0]?.laneId).toBe(row?.lane_id);
			const copied = await owner.query(`SELECT label, user_id, organization_id FROM application_lane WHERE id = $1`, [
				row?.lane_id,
			]);
			expect(copied.rows).toEqual([{ label: "Guest lane", user_id: ids.target, organization_id: ids.orgT }]);
			// The account's pipeline exists in its organization with a bumped revision, and has the default lanes.
			const pipeline = await owner.query(
				`SELECT revision FROM application_pipeline WHERE organization_id = $1 AND user_id = $2`,
				[ids.orgT, ids.target],
			);
			expect(pipeline.rows).toEqual([{ revision: 1 }]);
			expect(
				await rowCount(`SELECT count(*) AS n FROM application_lane WHERE organization_id = $1 AND user_id = $2`, [
					ids.orgT,
					ids.target,
				]),
			).toBe(7);
			const profile = await owner.query(
				`SELECT user_id, organization_id, revision FROM application_profile WHERE user_id = $1`,
				[ids.target],
			);
			expect(profile.rows).toEqual([
				{ user_id: ids.target, organization_id: ids.orgT, revision: expect.not.stringMatching(/^guest-rev$/) },
			]);
		});

		it("refuses a profile on both sides, and a source that is not a guest", async () => {
			await owner.query(
				`INSERT INTO application_profile (organization_id, user_id, data, reviewed_at, revision) VALUES ($1, $2, '{}', now(), 'g2')`,
				[ids.orgG, ids.guest2],
			);
			// The target now has a profile in its organization from the previous test.
			await expect(
				inApp(() => linkAnonymousAccount({ fromUserId: ids.guest2, toUserId: ids.target })),
			).rejects.toMatchObject({
				body: { message: expect.stringContaining("private application profile") },
			});
			expect(await rowCount(`SELECT count(*) AS n FROM application_profile WHERE user_id = $1`, [ids.guest2])).toBe(1);

			// A regular account's applications are not guest work.
			await expect(
				inApp(() => linkAnonymousAccount({ fromUserId: ids.userA, toUserId: ids.target })),
			).rejects.toBeDefined();
			expect(
				await rowCount(`SELECT count(*) AS n FROM application WHERE id = $1 AND user_id = $2`, [ids.appA, ids.userA]),
			).toBe(1);
		});

		it("refuses a merged pipeline over 40 active lanes", async () => {
			await seedGuest(ids.guest3, "three");
			// 35 custom lanes in the account's organization, plus 6 defaults, plus the guest's one: over the limit.
			await owner.query(
				`INSERT INTO application_lane (id, organization_id, user_id, category, label, color, position)
				 SELECT 'cap-' || n || '-${run}', $1, $2, 'saved', 'Custom ' || n, '#123456', 20 + n FROM generate_series(1, 35) AS n`,
				[ids.orgT, ids.target],
			);
			await expect(
				inApp(() => linkAnonymousAccount({ fromUserId: ids.guest3, toUserId: ids.target })),
			).rejects.toMatchObject({
				body: { message: expect.stringContaining("exceeds 40 active lanes") },
			});
			expect(await rowCount(`SELECT count(*) AS n FROM application WHERE user_id = $1`, [ids.guest3])).toBe(1);
		});
	});

	describe("background paths", () => {
		it("answers one fact about one application to careeros_app, and refuses a role without EXECUTE", async () => {
			const org = await app.query(`SELECT careeros_application_org($1, $2) AS org`, [ids.appA, ids.userA]);
			expect(org.rows).toEqual([{ org: ids.orgA }]);
			// Naming the wrong owner finds nothing.
			expect((await app.query(`SELECT careeros_application_org($1, $2) AS org`, [ids.appA, ids.userB])).rows).toEqual([
				{ org: null },
			]);
			expect(
				(await app.query(`SELECT careeros_application_is_open($1, $2) AS open`, [ids.appA, ids.userA])).rows,
			).toEqual([{ open: true }]);
			expect(
				(await app.query(`SELECT careeros_application_is_open($1, $2) AS open`, [ids.appA, ids.userB])).rows,
			).toEqual([{ open: false }]);

			const client = await owner.connect();
			try {
				await client.query(`SET ROLE "${ids.role}"`);
				for (const sql of [
					`SELECT careeros_application_org('${ids.appA}', '${ids.userA}')`,
					`SELECT careeros_application_is_open('${ids.appA}', '${ids.userA}')`,
					`SELECT careeros_move_guest_applications('a', 'b', 'c')`,
				])
					await expect(client.query(sql), sql).rejects.toMatchObject({ code: "42501" });
			} finally {
				await client.query("RESET ROLE").catch(() => undefined);
				client.release();
			}
		});

		it("runs a scheduled briefing for an application inside the application's organization", async () => {
			const { runCareerJobs } = await import("../career/jobs");
			await owner.query(
				`INSERT INTO career_schedule (id, user_id, application_id, interview_id, kind, lead, enabled, next_run_at) VALUES ($1, $2, $3, $4, 'prepare', '24h', true, '1999-01-01')`,
				[ids.schedule, ids.userA, ids.appA, ids.interview],
			);
			// The tick has no organization of its own; a closed application is skipped, an open one runs.
			await owner.query(`UPDATE application SET status = 'closed' WHERE id = $1`, [ids.appA]);
			await inApp(() => runCareerJobs());
			expect(generated.calls.filter((call) => call.applicationId === ids.appA)).toEqual([]);
			expect(await rowCount(`SELECT count(*) AS n FROM career_job WHERE schedule_id = $1`, [ids.schedule])).toBe(0);

			await owner.query(`UPDATE application SET status = 'interview', lane_id = $2 WHERE id = $1`, [
				ids.appA,
				ids.laneA,
			]);
			await inApp(() => runCareerJobs());
			expect(generated.calls.filter((call) => call.applicationId === ids.appA)).toEqual([{ applicationId: ids.appA }]);
			const job = await owner.query(`SELECT status FROM career_job WHERE schedule_id = $1`, [ids.schedule]);
			expect(job.rows).toEqual([{ status: "completed" }]);
		});
	});
});
