import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { Pool } from "pg";
import { withDatabasePool } from "@reactive-resume/db/client";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

// This suite needs the real organization scope, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());

// P1-T05 review 1 H1: the scheduled Trash purge runs once per organization through
// `careeros_orgs_with_expired_trash`, as the `careeros_app` role (NOBYPASSRLS). Skipped only when the CAREEROS_TEST_*
// variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("scheduled Trash purge", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `purge-a-${run}`,
		orgB: `purge-b-${run}`,
		// Not a valid organization id for withOrgContext, so that organization's purge fails as a whole.
		orgBad: `purge bad ${run}`,
		userA: `purge-user-a-${run}`,
		userB: `purge-user-b-${run}`,
		userBad: `purge-user-bad-${run}`,
		role: `t05_noexec_${run}`,
	};
	let owner: Pool;
	let app: Pool;
	const old = "now() - interval '40 days'";

	const exists = async (table: string, id: string) =>
		Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE id = $1`, [id])).rows[0]?.n) ===
		1;
	const seedRow = async (
		kind: "resume" | "letter",
		id: string,
		orgId: string,
		userId: string,
		trashed: string | null,
	) => {
		if (kind === "resume")
			await owner.query(
				`INSERT INTO resume (id, name, slug, data, user_id, organization_id, trashed_at) VALUES ($1, $1, $1, $2, $3, $4, ${trashed ?? "NULL"})`,
				[id, JSON.stringify(defaultResumeData), userId, orgId],
			);
		else
			await owner.query(
				`INSERT INTO cover_letter (id, name, style, user_id, organization_id, trashed_at) VALUES ($1, $1, '{}', $2, $3, ${trashed ?? "NULL"})`,
				[id, userId, orgId],
			);
	};

	beforeAll(async () => {
		owner = new Pool({ connectionString: process.env.CAREEROS_TEST_DATABASE_URL });
		app = new Pool({ connectionString: process.env.CAREEROS_TEST_APP_DATABASE_URL });
		for (const [org, user] of [
			[ids.orgA, ids.userA],
			[ids.orgB, ids.userB],
			[ids.orgBad, ids.userBad],
		] as const) {
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[user],
			);
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [
				`m-${user}`,
				org,
				user,
			]);
		}
		await owner.query(`CREATE ROLE "${ids.role}" NOLOGIN`);
	});

	afterAll(async () => {
		await owner?.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [[ids.orgA, ids.orgB, ids.orgBad]]);
		await owner?.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[ids.userA, ids.userB, ids.userBad]]);
		await owner?.query(`DROP ROLE IF EXISTS "${ids.role}"`);
		await owner?.end();
		await app?.end();
	});

	it("purges expired Trash in every organization in one tick and keeps the rest", async () => {
		const { documentsService } = await import("./service");
		for (const [org, user, tag] of [
			[ids.orgA, ids.userA, "a"],
			[ids.orgB, ids.userB, "b"],
		] as const) {
			await seedRow("resume", `old-resume-${tag}-${run}`, org, user, old);
			await seedRow("letter", `old-letter-${tag}-${run}`, org, user, old);
			await seedRow("resume", `new-resume-${tag}-${run}`, org, user, "now() - interval '1 day'");
			await seedRow("letter", `new-letter-${tag}-${run}`, org, user, "now() - interval '1 day'");
			await seedRow("letter", `live-letter-${tag}-${run}`, org, user, null);
		}
		await withDatabasePool(app, () => documentsService.purgeExpiredTrash());
		for (const tag of ["a", "b"]) {
			expect(await exists("resume", `old-resume-${tag}-${run}`), `old resume ${tag}`).toBe(false);
			expect(await exists("cover_letter", `old-letter-${tag}-${run}`), `old letter ${tag}`).toBe(false);
			expect(await exists("resume", `new-resume-${tag}-${run}`), `recent resume ${tag}`).toBe(true);
			expect(await exists("cover_letter", `new-letter-${tag}-${run}`), `recent letter ${tag}`).toBe(true);
			expect(await exists("cover_letter", `live-letter-${tag}-${run}`), `active letter ${tag}`).toBe(true);
		}
	});

	it("keeps going when one organization's purge fails", async () => {
		const { documentsService } = await import("./service");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await seedRow("letter", `bad-letter-${run}`, ids.orgBad, ids.userBad, old);
		await seedRow("letter", `ok-letter-${run}`, ids.orgA, ids.userA, old);
		await seedRow("letter", `ok-letter-b-${run}`, ids.orgB, ids.userB, old);
		await withDatabasePool(app, () => documentsService.purgeExpiredTrash());
		expect(error).toHaveBeenCalled();
		error.mockRestore();
		expect(await exists("cover_letter", `bad-letter-${run}`), "the failing organization's row stays").toBe(true);
		expect(await exists("cover_letter", `ok-letter-${run}`)).toBe(false);
		expect(await exists("cover_letter", `ok-letter-b-${run}`)).toBe(false);
	});

	it("returns organization ids only to careeros_app, and refuses a role without EXECUTE", async () => {
		await seedRow("letter", `fn-letter-${run}`, ids.orgA, ids.userA, old);
		const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const asApp = await app.query(`SELECT careeros_orgs_with_expired_trash($1::timestamptz) AS org`, [cutoff]);
		const orgs = asApp.rows.map((row) => row.org);
		expect(orgs).toContain(ids.orgA);
		for (const org of orgs) expect(typeof org).toBe("string");
		// A fresh cutoff in the past finds nothing of this run's rows.
		const none = await app.query(`SELECT careeros_orgs_with_expired_trash($1::timestamptz) AS org`, [
			new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
		]);
		expect(none.rows.map((row) => row.org)).not.toContain(ids.orgA);

		const client = await owner.connect();
		try {
			await client.query(`SET ROLE "${ids.role}"`);
			await expect(
				client.query(`SELECT careeros_orgs_with_expired_trash($1::timestamptz)`, [cutoff]),
			).rejects.toMatchObject({ code: "42501" });
		} finally {
			await client.query("RESET ROLE").catch(() => undefined);
			client.release();
		}
		// Without an organization the application role still sees no letters directly.
		expect((await app.query(`SELECT count(*)::int AS n FROM cover_letter`)).rows[0]).toEqual({ n: 0 });
	});
});
