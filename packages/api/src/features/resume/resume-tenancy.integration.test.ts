import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { isolationRegistry, runApiIsolationCheck } from "@careeros/isolation-testing";
import { createRouterClient } from "@orpc/server";
import { Pool } from "pg";
import { linkAnonymousAccount } from "@reactive-resume/auth/config";
import { withDatabasePool } from "@reactive-resume/db/client";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { downloadResumePdfProcedure } from "./export";
import { lookupPublicResumeOrg } from "./public-scope";
import { resumeRouter } from "./router";
import { getPublicResumeCardData } from "./social-meta";
import { countIndexableResumes, listIndexableResumes, loadPublicWebPage } from "./web-page";

// This suite needs the real organization scope, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());

// P1-T04: resume tenancy through the real routers, as the `careeros_app` role (NOBYPASSRLS), against the migrated
// public schema. Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("resumes and tenant isolation", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `org-a-${run}`,
		orgB: `org-b-${run}`,
		orgG: `org-g-${run}`,
		userA: `user-a-${run}`,
		userB: `user-b-${run}`,
		guest: `user-guest-${run}`,
		usernameA: `alice-${run}`,
		publicResume: `res-public-${run}`,
		privateResume: `res-private-${run}`,
		passwordResume: `res-password-${run}`,
		trashedResume: `res-trashed-${run}`,
		bobResume: `res-bob-${run}`,
		version: `ver-${run}`,
		guestResume: `res-guest-${run}`,
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
	const clientFor = (userId: string, activeOrganizationId: string | null, reqHeaders = new Headers()) =>
		createRouterClient(resumeRouter, {
			context: {
				locale: "en-US",
				reqHeaders,
				resHeaders: new Headers(),
				authentication: {
					user: user(userId),
					method: "session",
					permissions: ["read", "write", "delete"],
					activeOrganizationId,
				},
			},
		});
	const anonymousClient = () =>
		createRouterClient(resumeRouter, {
			context: { locale: "en-US", reqHeaders: new Headers(), resHeaders: new Headers(), authentication: null },
		});
	const rowCount = async (sql: string, params: unknown[] = []) =>
		Number((await owner.query<{ n: string }>(sql, params)).rows[0]?.n);

	beforeAll(async () => {
		owner = new Pool({ connectionString: process.env.CAREEROS_TEST_DATABASE_URL });
		app = new Pool({ connectionString: process.env.CAREEROS_TEST_APP_DATABASE_URL });
		await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, 'A', $1), ($2, 'B', $2), ($3, 'G', $3)`, [
			ids.orgA,
			ids.orgB,
			ids.orgG,
		]);
		for (const [id, username, anonymous] of [
			[ids.userA, ids.usernameA, false],
			[ids.userB, `bob-${run}`, false],
			[ids.guest, `guest-${run}`, true],
		] as const) {
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username, is_anonymous) VALUES ($1, $1, $1 || '@example.test', $2, $2, $3)`,
				[id, username, anonymous],
			);
		}
		await owner.query(
			`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner'), ($4, $5, $6, 'owner'), ($7, $8, $9, 'owner')`,
			[`m-a-${run}`, ids.orgA, ids.userA, `m-b-${run}`, ids.orgB, ids.userB, `m-g-${run}`, ids.orgG, ids.guest],
		);
		const data = JSON.stringify(defaultResumeData);
		await owner.query(
			`INSERT INTO resume (id, name, slug, data, user_id, organization_id, is_public, show_in_search_engines, password, trashed_at) VALUES
			 ($1, 'Public', 'public', $7, $8, $9, true, true, null, null),
			 ($2, 'Private', 'private', $7, $8, $9, false, false, null, null),
			 ($3, 'Password', 'password', $7, $8, $9, true, false, 'hash', null),
			 ($4, 'Trashed', 'trashed', $7, $8, $9, true, false, null, now()),
			 ($5, 'Bob', 'bob', $7, $10, $11, true, false, null, null),
			 ($6, 'Guest', 'guest', $7, $12, $13, false, false, null, null)`,
			[
				ids.publicResume,
				ids.privateResume,
				ids.passwordResume,
				ids.trashedResume,
				ids.bobResume,
				ids.guestResume,
				data,
				ids.userA,
				ids.orgA,
				ids.userB,
				ids.orgB,
				ids.guest,
				ids.orgG,
			],
		);
		await owner.query(
			`INSERT INTO resume_version (id, resume_id, user_id, data, kind, name, organization_id) VALUES ($1, $2, $3, $4, 'named', 'v1', $5)`,
			[ids.version, ids.privateResume, ids.userA, data, ids.orgA],
		);
	});

	afterAll(async () => {
		// Organizations cascade their tenant rows; the users go with their remaining rows.
		await owner?.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [[ids.orgA, ids.orgB, ids.orgG]]);
		await owner?.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[ids.userA, ids.userB, ids.guest]]);
		await owner?.end();
		await app?.end();
	});

	describe("the other organization's user", () => {
		it("gets NOT_FOUND for the first organization's resume on every resume procedure, and nothing changes", async () => {
			const b = clientFor(ids.userB, ids.orgB);
			const id = ids.privateResume;
			const calls: [string, () => Promise<unknown>][] = [
				["getById", () => b.getById({ id })],
				["update", () => b.update({ id, name: "Hijacked", isPublic: true })],
				["patch", () => b.patch({ id, operations: [{ op: "replace", path: "/basics/name", value: "Hijacked" }] })],
				["setLocked", () => b.setLocked({ id, isLocked: true })],
				["setPassword", () => b.setPassword({ id, password: "hijacked-password" })],
				["removePassword", () => b.removePassword({ id })],
				["duplicate", () => b.duplicate({ id })],
				["delete", () => b.delete({ id })],
				["listVersions", () => b.listVersions({ resumeId: id })],
				["getVersion", () => b.getVersion({ resumeId: id, versionId: ids.version })],
				["createVersion", () => b.createVersion({ resumeId: id, name: "Stolen" })],
				["renameVersion", () => b.renameVersion({ resumeId: id, versionId: ids.version, name: "Hijacked" })],
				["deleteVersion", () => b.deleteVersion({ resumeId: id, versionId: ids.version })],
				["restoreVersion", () => b.restoreVersion({ resumeId: id, versionId: ids.version })],
				["previewUrl", () => b.previewUrl({ id })],
				["statistics.getById", () => b.statistics.getById({ id })],
				["statistics.getDailyById", () => b.statistics.getDailyById({ id, days: 7 })],
				[
					"updates.subscribe",
					async () => {
						const stream = await b.updates.subscribe({ id });
						return stream[Symbol.asyncIterator]().next();
					},
				],
				[
					"downloadResumePdf",
					() =>
						createRouterClient(
							{ download: downloadResumePdfProcedure },
							{ context: contextFor(ids.userB, ids.orgB) },
						).download({ id }),
				],
			];
			for (const [name, call] of calls) {
				await expect(inApp(call), name).rejects.toMatchObject({ code: "NOT_FOUND" });
			}

			const { rows } = await owner.query(`SELECT name, is_public, is_locked, password FROM resume WHERE id = $1`, [id]);
			expect(rows).toEqual([{ name: "Private", is_public: false, is_locked: false, password: null }]);
			expect(await rowCount(`SELECT count(*) AS n FROM resume WHERE user_id = $1`, [ids.userB])).toBe(1);
			expect(
				await rowCount(`SELECT count(*) AS n FROM resume_version WHERE id = $1 AND name = 'v1'`, [ids.version]),
			).toBe(1);
		});

		const contextFor = (userId: string, activeOrganizationId: string) => ({
			locale: "en-US" as const,
			reqHeaders: new Headers(),
			resHeaders: new Headers(),
			authentication: {
				user: user(userId),
				method: "session" as const,
				permissions: ["read", "write", "delete"] as const,
				activeOrganizationId,
			},
		});

		it("lists only its own resumes, while the owner sees the first organization's", async () => {
			const listed = (await inApp(() => clientFor(ids.userB, ids.orgB).list({ tags: [], sort: "name" }))).map(
				(resume) => resume.id,
			);
			expect(listed).toEqual([ids.bobResume]);
			const ownerList = (await inApp(() => clientFor(ids.userA, ids.orgA).list({ tags: [], sort: "name" }))).map(
				(resume) => resume.id,
			);
			expect(ownerList).toEqual(expect.arrayContaining([ids.publicResume, ids.privateResume]));
			expect(ownerList).not.toContain(ids.bobResume);
		});

		it("is refused when it names an organization it does not belong to", async () => {
			await expect(
				inApp(() => clientFor(ids.userB, ids.orgA).getById({ id: ids.privateResume })),
				"a session whose active organization is not backed by membership",
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});

		it("passes the isolation suite's API check for the resume route group", async () => {
			const entry = isolationRegistry.find((candidate) => candidate.table === "resume");
			if (!entry) throw new Error("resume is not registered");
			const org = (orgId: string) => (orgId === ids.orgB ? { userId: ids.userB } : undefined);
			const result = await runApiIsolationCheck(
				{
					...entry,
					api: {
						get: async (session, id) => {
							const member = org(session.orgId);
							if (!member) throw new Error("unexpected organization");
							try {
								await inApp(() => clientFor(member.userId, session.orgId).getById({ id }));
								return { status: 200 };
							} catch (error) {
								return { status: (error as { status?: number }).status ?? 500 };
							}
						},
						list: async (session) => {
							const member = org(session.orgId);
							if (!member) throw new Error("unexpected organization");
							const items = await inApp(() => clientFor(member.userId, session.orgId).list({ tags: [], sort: "name" }));
							return { status: 200, ids: items.map((item) => item.id) };
						},
					},
				},
				{ owner, orgA: ids.orgA, orgB: ids.orgB },
			);
			expect(result.failures).toEqual([]);
			await owner.query(`DELETE FROM "user" WHERE id LIKE 'iso-user-%'`);
		});
	});

	describe("the database", () => {
		it("refuses a write for another organization and a write without any organization", async () => {
			const { withOrgContext } = await import("@careeros/tenancy");
			const insert = (orgId: string) =>
				`INSERT INTO resume (id, name, slug, data, user_id, organization_id) VALUES ('x-${randomUUID()}', 'X', 'x', '{}', '${ids.userB}', '${orgId}')`;
			await expect(
				inApp(() =>
					withOrgContext(ids.orgB, async () =>
						(await import("@reactive-resume/db/client")).getPool().query(insert(ids.orgA)),
					),
				),
			).rejects.toMatchObject({ code: "42501" });
			await expect(inApp(() => app.query(insert(ids.orgB)))).rejects.toMatchObject({ code: "42501" });
			expect(await rowCount(`SELECT count(*) AS n FROM resume WHERE slug = 'x' AND user_id = $1`, [ids.userB])).toBe(0);
		});

		it("serves rows only to the matching organization and none without one", async () => {
			expect((await app.query(`SELECT count(*)::int AS n FROM resume`)).rows[0]).toEqual({ n: 0 });
			for (const table of ["resume_version", "resume_slug_redirect", "resume_statistics", "resume_statistics_daily"]) {
				expect((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0], table).toEqual({ n: 0 });
			}
		});
	});

	describe("public access without a session", () => {
		it("resolves a public resume's organization through the definer functions, and a private one not at all", async () => {
			const lookup = (match: Parameters<typeof lookupPublicResumeOrg>[0]) => inApp(() => lookupPublicResumeOrg(match));
			expect(await lookup({ username: ids.usernameA, slug: "public" })).toBe(ids.orgA);
			expect(await lookup({ username: ids.usernameA.toUpperCase(), slug: "public" })).toBe(ids.orgA);
			expect(await lookup({ username: ids.usernameA, slug: "password" }), "password-protected resumes are public").toBe(
				ids.orgA,
			);
			expect(await lookup({ username: ids.usernameA, slug: "private" })).toBeUndefined();
			expect(await lookup({ username: ids.usernameA, slug: "trashed" })).toBeUndefined();
			expect(await lookup({ username: ids.usernameA, slug: "missing" })).toBeUndefined();
			expect(await lookup({ id: ids.publicResume })).toBe(ids.orgA);
			expect(await lookup({ id: ids.privateResume })).toBeUndefined();
			expect(await lookup({ username: ids.usernameA, primary: true })).toBeUndefined();
		});

		it("follows a primary resume and an unexpired slug redirect, and stops at an expired one or a banned owner", async () => {
			const lookup = (match: Parameters<typeof lookupPublicResumeOrg>[0]) => inApp(() => lookupPublicResumeOrg(match));
			await owner.query(
				`INSERT INTO resume_slug_redirect (id, slug, resume_id, user_id, expires_at, organization_id) VALUES
				 ($1, 'old-public', $2, $3, now() + interval '1 day', $4), ($5, 'old-expired', $2, $3, now() - interval '1 day', $4),
				 ($6, 'old-private', $7, $3, now() + interval '1 day', $4)`,
				[`red1-${run}`, ids.publicResume, ids.userA, ids.orgA, `red2-${run}`, `red3-${run}`, ids.privateResume],
			);
			expect(await lookup({ username: ids.usernameA, slug: "old-public" })).toBe(ids.orgA);
			expect(await lookup({ username: ids.usernameA, slug: "old-expired" })).toBeUndefined();
			expect(await lookup({ username: ids.usernameA, slug: "old-private" })).toBeUndefined();

			await owner.query(`UPDATE resume SET is_primary = true WHERE id = $1`, [ids.publicResume]);
			expect(await lookup({ username: ids.usernameA, primary: true })).toBe(ids.orgA);

			await owner.query(`UPDATE "user" SET banned = true WHERE id = $1`, [ids.userA]);
			try {
				expect(await lookup({ username: ids.usernameA, slug: "public" })).toBeUndefined();
				expect(await lookup({ username: ids.usernameA, slug: "old-public" })).toBeUndefined();
				expect(await lookup({ username: ids.usernameA, primary: true })).toBeUndefined();
				expect(await lookup({ id: ids.publicResume })).toBeUndefined();
			} finally {
				await owner.query(`UPDATE "user" SET banned = false WHERE id = $1`, [ids.userA]);
				await owner.query(`UPDATE resume SET is_primary = false WHERE id = $1`, [ids.publicResume]);
			}
		});

		it("serves a public resume to an anonymous visitor and counts the view in the resume's organization", async () => {
			const resume = await inApp(() => anonymousClient().getBySlug({ username: ids.usernameA, slug: "public" }));
			expect(resume.id).toBe(ids.publicResume);
			const stats = await owner.query<{ organization_id: string; views: number }>(
				`SELECT organization_id, views FROM resume_statistics WHERE resume_id = $1`,
				[ids.publicResume],
			);
			expect(stats.rows).toEqual([{ organization_id: ids.orgA, views: 1 }]);
			const daily = await owner.query<{ organization_id: string }>(
				`SELECT organization_id FROM resume_statistics_daily WHERE resume_id = $1`,
				[ids.publicResume],
			);
			expect(daily.rows).toEqual([{ organization_id: ids.orgA }]);
		});

		it("answers NOT_FOUND to an anonymous visitor for a private resume, and for another organization's address", async () => {
			await expect(
				inApp(() => anonymousClient().getBySlug({ username: ids.usernameA, slug: "private" })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				inApp(() => anonymousClient().getBySlug({ username: ids.usernameA, slug: "trashed" })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		it("lets the owner open their own private resume through their own organization, but not another organization's user", async () => {
			const asOwner = await inApp(() =>
				clientFor(ids.userA, ids.orgA, new Headers()).getBySlug({ username: ids.usernameA, slug: "private" }),
			);
			expect(asOwner.id).toBe(ids.privateResume);
			await expect(
				inApp(() => clientFor(ids.userB, ids.orgB).getBySlug({ username: ids.usernameA, slug: "private" })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		it("records a visitor's download in the resume's organization", async () => {
			await expect(
				inApp(() => anonymousClient().statistics.recordDownload({ username: ids.usernameA, slug: "public" })),
			).resolves.toBe(true);
			const stats = await owner.query<{ organization_id: string; downloads: number }>(
				`SELECT organization_id, downloads FROM resume_statistics WHERE resume_id = $1`,
				[ids.publicResume],
			);
			expect(stats.rows).toEqual([{ organization_id: ids.orgA, downloads: 1 }]);
		});

		it("renders the public web page and the link-preview card without a session", async () => {
			const page = await inApp(() =>
				loadPublicWebPage({
					match: { username: ids.usernameA, slug: "public" },
					requestHeaders: new Headers({ "user-agent": "crawler bot" }),
					trustedClient: "test",
				}),
			);
			expect(page).toMatchObject({ status: "ok", slug: "public" });
			const gated = await inApp(() =>
				loadPublicWebPage({
					match: { username: ids.usernameA, slug: "password" },
					requestHeaders: new Headers(),
					trustedClient: "test",
				}),
			);
			expect(gated.status).toBe("password");
			const missing = await inApp(() =>
				loadPublicWebPage({
					match: { username: ids.usernameA, slug: "private" },
					requestHeaders: new Headers(),
					trustedClient: "test",
				}),
			);
			expect(missing.status).toBe("unavailable");
			expect(await inApp(() => getPublicResumeCardData({ username: ids.usernameA, slug: "public" }))).not.toBeNull();
			expect(await inApp(() => getPublicResumeCardData({ username: ids.usernameA, slug: "password" }))).toBeNull();
		});

		it("lists searchable public resumes in the sitemap without exposing any other column", async () => {
			const listed = await inApp(() => listIndexableResumes(0));
			expect(listed.some((item) => item.username === ids.usernameA && item.slug === "public")).toBe(true);
			expect(listed.some((item) => item.slug === "private" || item.slug === "password")).toBe(false);
			expect(Object.keys(listed[0] ?? {}).sort()).toEqual(["isPrimary", "slug", "updatedAt", "username"]);
			expect(await inApp(() => countIndexableResumes())).toBeGreaterThanOrEqual(1);
		});

		it("counts every organization's resumes for the public total, as one number", async () => {
			const { rows } = await app.query<{ n: string }>(`SELECT public.careeros_resume_count() AS n`);
			expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(5);
		});

		it("does not let the application role call the definer functions as another role would, or read through them", async () => {
			// The functions answer only with an organization id or public listing data, never with a row.
			const { rows } = await app.query(`SELECT public.careeros_public_resume_org($1, 'private') AS org`, [
				ids.usernameA,
			]);
			expect(rows).toEqual([{ org: null }]);
			await expect(
				app.query(`SELECT * FROM public.careeros_public_resume_org($1, 'public') AS t(org)`, [ids.usernameA]),
			).resolves.toBeDefined();
		});
	});

	describe("work that outlives the request scope", () => {
		it("lets the resume update stream read its resume after the handler returned", async () => {
			const controller = new AbortController();
			const events = await inApp(async () => {
				const stream = await clientFor(ids.userA, ids.orgA).updates.subscribe(
					{ id: ids.publicResume },
					{ signal: controller.signal },
				);
				const iterator = stream[Symbol.asyncIterator]();
				const first = await iterator.next();
				controller.abort();
				await iterator.return?.(undefined).catch(() => undefined);
				return first;
			});
			expect(events.value).toMatchObject({ type: "resume.updated", resumeId: ids.publicResume, mutation: "sync" });
		});
	});

	describe("guest linking", () => {
		it("moves a guest's resume to the account's organization, and refuses to move a non-guest's", async () => {
			await inApp(() => linkAnonymousAccount({ fromUserId: ids.guest, toUserId: ids.userA }));
			const moved = await owner.query<{ user_id: string; organization_id: string }>(
				`SELECT user_id, organization_id FROM resume WHERE id = $1`,
				[ids.guestResume],
			);
			expect(moved.rows).toEqual([{ user_id: ids.userA, organization_id: ids.orgA }]);

			// Bob is a regular account: the definer function refuses to treat his resume as guest work.
			await expect(
				inApp(() => linkAnonymousAccount({ fromUserId: ids.userB, toUserId: ids.userA })),
			).rejects.toBeDefined();
			const bob = await owner.query<{ user_id: string; organization_id: string }>(
				`SELECT user_id, organization_id FROM resume WHERE id = $1`,
				[ids.bobResume],
			);
			expect(bob.rows).toEqual([{ user_id: ids.userB, organization_id: ids.orgB }]);
		});
	});
});
