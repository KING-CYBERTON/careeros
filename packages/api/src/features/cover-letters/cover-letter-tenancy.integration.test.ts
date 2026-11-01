import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { isolationRegistry, runApiIsolationCheck } from "@careeros/isolation-testing";
import { createRouterClient } from "@orpc/server";
import { Pool } from "pg";
import { getPool, withDatabasePool } from "@reactive-resume/db/client";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { coverLettersRouter } from "./router";

// This suite needs the real organization scope, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());

// P1-T05: cover letter tenancy through the real router, as the `careeros_app` role (NOBYPASSRLS), against the migrated
// public schema. Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("cover letters and tenant isolation", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `org-a-${run}`,
		orgB: `org-b-${run}`,
		userA: `user-a-${run}`,
		userB: `user-b-${run}`,
		letter: `letter-a-${run}`,
		letterB: `letter-b-${run}`,
		version: `lver-a-${run}`,
		resumeA: `res-a-${run}`,
		resumeB: `res-b-${run}`,
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
	const clientFor = (userId: string, activeOrganizationId: string) =>
		createRouterClient(coverLettersRouter, {
			context: {
				locale: "en-US",
				reqHeaders: new Headers(),
				resHeaders: new Headers(),
				authentication: {
					user: user(userId),
					method: "session",
					permissions: ["read", "write", "delete"],
					activeOrganizationId,
				},
			},
		});
	const rowCount = async (sql: string, params: unknown[] = []) =>
		Number((await owner.query<{ n: string }>(sql, params)).rows[0]?.n);

	beforeAll(async () => {
		owner = new Pool({ connectionString: process.env.CAREEROS_TEST_DATABASE_URL });
		app = new Pool({ connectionString: process.env.CAREEROS_TEST_APP_DATABASE_URL });
		await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, 'A', $1), ($2, 'B', $2)`, [
			ids.orgA,
			ids.orgB,
		]);
		for (const id of [ids.userA, ids.userB]) {
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[id],
			);
		}
		await owner.query(
			`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner'), ($4, $5, $6, 'owner')`,
			[`m-a-${run}`, ids.orgA, ids.userA, `m-b-${run}`, ids.orgB, ids.userB],
		);
		const data = JSON.stringify(defaultResumeData);
		await owner.query(
			`INSERT INTO resume (id, name, slug, data, user_id, organization_id) VALUES
			 ($1, 'Resume A', 'resume-a', $3, $4, $5), ($2, 'Resume B', 'resume-b', $3, $6, $7)`,
			[ids.resumeA, ids.resumeB, data, ids.userA, ids.orgA, ids.userB, ids.orgB],
		);
		const style = JSON.stringify({
			basics: defaultResumeData.basics,
			picture: defaultResumeData.picture,
			metadata: defaultResumeData.metadata,
			sectionId: "cover-letter-section",
			itemId: "cover-letter-item",
		});
		await owner.query(
			`INSERT INTO cover_letter (id, name, content, style, user_id, organization_id) VALUES
			 ($1, 'Letter A', '<p>Secret</p>', $3, $4, $5), ($2, 'Letter B', '<p>Mine</p>', $3, $6, $7)`,
			[ids.letter, ids.letterB, style, ids.userA, ids.orgA, ids.userB, ids.orgB],
		);
		await owner.query(
			`INSERT INTO cover_letter_version (id, cover_letter_id, user_id, data, kind, name, organization_id) VALUES ($1, $2, $3, '{}', 'named', 'v1', $4)`,
			[ids.version, ids.letter, ids.userA, ids.orgA],
		);
	});

	afterAll(async () => {
		// Organizations cascade their tenant rows; the users go with their remaining rows.
		await owner?.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [[ids.orgA, ids.orgB]]);
		await owner?.query(`DELETE FROM "user" WHERE id = ANY($1::text[]) OR id LIKE 'iso-user-%'`, [
			[ids.userA, ids.userB],
		]);
		await owner?.end();
		await app?.end();
	});

	describe("the other organization's user", () => {
		it("gets NOT_FOUND for the first organization's letter on every letter procedure, and nothing changes", async () => {
			const b = clientFor(ids.userB, ids.orgB);
			const id = ids.letter;
			const calls: [string, () => Promise<unknown>][] = [
				["getById", () => b.getById({ id })],
				["update", () => b.update({ id, expectedRevision: 1, name: "Hijacked" })],
				["refreshStyle", () => b.refreshStyle({ id, expectedRevision: 1, resumeId: ids.resumeB })],
				["duplicate", () => b.duplicate({ id })],
				["delete", () => b.delete({ id, expectedRevision: 1 })],
				["export", () => b.export({ id })],
				["listVersions", () => b.listVersions({ id, limit: 20, offset: 0 })],
				["getVersion", () => b.getVersion({ id, versionId: ids.version })],
				["createVersion", () => b.createVersion({ id, name: "Stolen" })],
				["renameVersion", () => b.renameVersion({ id, versionId: ids.version, name: "Hijacked" })],
				["deleteVersion", () => b.deleteVersion({ id, versionId: ids.version })],
				["restoreVersion", () => b.restoreVersion({ id, versionId: ids.version })],
				[
					"draft",
					async () => {
						const stream = await b.draft({ id, variant: "draft" });
						return stream[Symbol.asyncIterator]().next();
					},
				],
			];
			for (const [name, call] of calls) {
				await expect(inApp(call), name).rejects.toMatchObject({ code: "NOT_FOUND" });
			}

			const { rows } = await owner.query(`SELECT name, content, revision, trashed_at FROM cover_letter WHERE id = $1`, [
				id,
			]);
			expect(rows).toEqual([{ name: "Letter A", content: "<p>Secret</p>", revision: 1, trashed_at: null }]);
			expect(await rowCount(`SELECT count(*) AS n FROM cover_letter WHERE user_id = $1`, [ids.userB])).toBe(1);
			expect(
				await rowCount(`SELECT count(*) AS n FROM cover_letter_version WHERE id = $1 AND name = 'v1'`, [ids.version]),
			).toBe(1);
		});

		it("lists only its own letters, while the owner sees the first organization's", async () => {
			const listed = (await inApp(() => clientFor(ids.userB, ids.orgB).list({ limit: 100, offset: 0 }))).items.map(
				(letter) => letter.id,
			);
			expect(listed).toEqual([ids.letterB]);
			const ownerList = (await inApp(() => clientFor(ids.userA, ids.orgA).list({ limit: 100, offset: 0 }))).items.map(
				(letter) => letter.id,
			);
			expect(ownerList).toContain(ids.letter);
			expect(ownerList).not.toContain(ids.letterB);
		});

		it("is refused when it names an organization it does not belong to", async () => {
			await expect(
				inApp(() => clientFor(ids.userB, ids.orgA).getById({ id: ids.letter })),
				"a session whose active organization is not backed by membership",
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});

		it("cannot link a letter to the first organization's resume, on create or update", async () => {
			const b = clientFor(ids.userB, ids.orgB);
			await expect(inApp(() => b.create({ name: "Linked", resumeId: ids.resumeA }))).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(
				inApp(() => b.update({ id: ids.letterB, expectedRevision: 1, resumeId: ids.resumeA })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() => b.refreshStyle({ id: ids.letterB, expectedRevision: 1, resumeId: ids.resumeA })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(await rowCount(`SELECT count(*) AS n FROM cover_letter WHERE source_resume_id = $1`, [ids.resumeA])).toBe(
				0,
			);
			expect(await rowCount(`SELECT count(*) AS n FROM cover_letter WHERE name = 'Linked'`)).toBe(0);

			// Its own resume works, and the new letter and its first version carry its organization.
			const created = await inApp(() => b.create({ name: "Linked", resumeId: ids.resumeB }));
			const { rows } = await owner.query(
				`SELECT l.organization_id AS letter_org, v.organization_id AS version_org
				 FROM cover_letter l JOIN cover_letter_version v ON v.cover_letter_id = l.id WHERE l.id = $1`,
				[created.id],
			);
			expect(rows).toEqual([{ letter_org: ids.orgB, version_org: ids.orgB }]);
		});
	});

	describe("the isolation suite's API check", () => {
		it("passes for cover_letter and cover_letter_version", async () => {
			const b = clientFor(ids.userB, ids.orgB);
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

			const letterResult = await runApiIsolationCheck(
				{
					...entryFor("cover_letter"),
					api: {
						get: async (_session, id) => ({ status: await statusOf(() => b.getById({ id })) }),
						list: async () => ({
							status: 200,
							ids: (await inApp(() => b.list({ limit: 100, offset: 0 }))).items.map((item) => item.id),
						}),
					},
				},
				{ owner, orgA: ids.orgA, orgB: ids.orgB },
			);
			expect(letterResult.failures).toEqual([]);

			// A version is reached through its letter: the check looks the letter up, then asks as Org B.
			let letterId = "";
			const versionResult = await runApiIsolationCheck(
				{
					...entryFor("cover_letter_version"),
					api: {
						get: async (_session, id) => {
							letterId = (
								await owner.query<{ cover_letter_id: string }>(
									`SELECT cover_letter_id FROM cover_letter_version WHERE id = $1`,
									[id],
								)
							).rows[0]?.cover_letter_id as string;
							return { status: await statusOf(() => b.getVersion({ id: letterId, versionId: id })) };
						},
						list: async () => {
							try {
								const versions = await inApp(() => b.listVersions({ id: letterId, limit: 20, offset: 0 }));
								return { status: 200, ids: versions.map((version) => version.id) };
							} catch (error) {
								return { status: (error as { status?: number }).status ?? 500, ids: [] };
							}
						},
					},
				},
				{ owner, orgA: ids.orgA, orgB: ids.orgB },
			);
			expect(versionResult.failures).toEqual([]);
		});
	});

	describe("the database", () => {
		it("refuses a write for another organization and a write without any organization", async () => {
			const { withOrgContext } = await import("@careeros/tenancy");
			const insertLetter = (orgId: string) =>
				`INSERT INTO cover_letter (id, name, style, user_id, organization_id) VALUES ('x-${randomUUID()}', 'X', '{}', '${ids.userB}', '${orgId}')`;
			const insertVersion = (orgId: string) =>
				`INSERT INTO cover_letter_version (id, cover_letter_id, user_id, data, organization_id) VALUES ('xv-${randomUUID()}', '${ids.letterB}', '${ids.userB}', '{}', '${orgId}')`;
			for (const insert of [insertLetter, insertVersion]) {
				await expect(
					inApp(() => withOrgContext(ids.orgB, async () => getPool().query(insert(ids.orgA)))),
				).rejects.toMatchObject({ code: "42501" });
				await expect(inApp(() => app.query(insert(ids.orgB)))).rejects.toMatchObject({ code: "42501" });
			}
			expect(await rowCount(`SELECT count(*) AS n FROM cover_letter WHERE name = 'X'`)).toBe(0);
			expect(await rowCount(`SELECT count(*) AS n FROM cover_letter_version WHERE id LIKE 'xv-%'`)).toBe(0);
		});

		it("serves rows only to the matching organization and none without one", async () => {
			for (const table of ["cover_letter", "cover_letter_version"]) {
				expect((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0], table).toEqual({ n: 0 });
			}
			const { withOrgContext } = await import("@careeros/tenancy");
			const own = await inApp(() =>
				withOrgContext(ids.orgA, async () => getPool().query(`SELECT id FROM cover_letter ORDER BY id`)),
			);
			expect(own.rows.map((row) => row.id)).toContain(ids.letter);
			expect(own.rows.map((row) => row.id)).not.toContain(ids.letterB);
		});
	});
});
