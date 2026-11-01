import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { guardTestPool } from "@careeros/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// CAREEROS (P1-T05): the cover letter tenant migration on a database that already holds letters. Applies every
// migration before it (including P1-T04), seeds letters and versions for users with one, two and no organization, runs
// the migration, runs it a second time, then runs the down migration and the migration again. Needs CREATE DATABASE
// permission; owns and deletes one disposable database, never the supplied one.
const migrationsFolder = fileURLToPath(new URL("../../../migrations", import.meta.url));
const md5Of = (value: string) => createHash("md5").update(value).digest("hex");
const FOLDER = "20261101072723_cover_letters_rls";
const TABLES = ["cover_letter", "cover_letter_version"];

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("cover letter tenancy migration", () => {
	it("backfills organization ids, is idempotent, enables forced RLS, and reverses", async () => {
		const databaseUrl = process.env.COVER_LETTER_TEST_DATABASE_URL;
		if (!databaseUrl) throw new Error("COVER_LETTER_TEST_DATABASE_URL is required");
		const admin = new Pool({ connectionString: databaseUrl });
		const baselineFolder = await mkdtemp(path.join(tmpdir(), "careeros-t05-migrations-"));
		const databaseName = `migration_t05_${randomUUID().replaceAll("-", "")}`;
		let pool: Pool | undefined;
		let closePool: (() => Promise<void>) | undefined;
		try {
			for (const name of await readdir(migrationsFolder)) {
				if (name < FOLDER) await symlink(path.join(migrationsFolder, name), path.join(baselineFolder, name));
			}
			await admin.query(`CREATE DATABASE "${databaseName}"`);
			const url = new URL(databaseUrl);
			url.pathname = `/${databaseName}`;
			pool = new Pool({ connectionString: url.toString(), max: 1 });
			closePool = guardTestPool(pool).close;
			await migrate(drizzle({ client: pool }), { migrationsFolder: baselineFolder });
			const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
				(await (pool as Pool).query<T>(sql, params)).rows;

			// Before: u1 belongs to two organizations (the older one wins), u2 to one, u3 to none but has a letter, u4 has
			// no letters at all (and must not get an organization from this migration).
			for (const id of ["u1", "u2", "u3", "u4"]) {
				await q(`INSERT INTO "user" (id,name,email,username,display_username) VALUES ($1,$1,$1||'@x.test',$1,$1)`, [
					id,
				]);
			}
			await q(
				`INSERT INTO organization (id,name,slug) VALUES ('o-old','Old','o-old'),('o-new','New','o-new'),('o-2','Two','o-2')`,
			);
			await q(`INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES
				('m1a','o-new','u1','member','2026-02-01'),('m1b','o-old','u1','owner','2026-01-01'),('m2','o-2','u2','owner','2026-01-01')`);
			const style = JSON.stringify({ sectionId: "s", itemId: "i" });
			await q(
				`INSERT INTO cover_letter (id,name,style,user_id) VALUES ('l1','L1',$1,'u1'),('l2','L2',$1,'u1'),('l3','L3',$1,'u2'),('l4','L4',$1,'u3')`,
				[style],
			);
			await q(
				`INSERT INTO cover_letter_version (id,cover_letter_id,user_id,data) VALUES ('v1','l1','u1','{}'),('v2','l2','u1','{}'),('v3','l3','u2','{}'),('v4','l4','u3','{}')`,
			);

			const migration = await readFile(path.join(migrationsFolder, FOLDER, "migration.sql"), "utf8");
			const down = await readFile(path.join(migrationsFolder, FOLDER, "down.sql"), "utf8");
			const snapshot = async () => ({
				organizations: await q(`SELECT id,name,slug,metadata FROM organization ORDER BY id`),
				members: await q(`SELECT id,organization_id,user_id,role FROM member ORDER BY id`),
				rows: await q(`SELECT 'letter' AS t,id,organization_id FROM cover_letter UNION ALL
					SELECT 'version',id,organization_id FROM cover_letter_version ORDER BY 1,2`),
			});

			await q(migration);
			const first = await snapshot();

			// A user with letters and no organization got a personal one; a user without letters did not.
			const backfilledId = `bf_${md5Of("u3")}`;
			expect(first.organizations.filter((o) => o.metadata === '{"careeros_backfill":true}')).toEqual([
				expect.objectContaining({ id: backfilledId, name: "u3's workspace" }),
			]);
			expect(first.members.filter((m) => m.user_id === "u3")).toEqual([
				{ id: backfilledId, organization_id: backfilledId, user_id: "u3", role: "owner" },
			]);
			expect(first.members.filter((m) => m.user_id === "u4")).toEqual([]);
			// Letters take the owner's oldest membership; versions follow their letter.
			expect(first.rows).toEqual([
				{ t: "letter", id: "l1", organization_id: "o-old" },
				{ t: "letter", id: "l2", organization_id: "o-old" },
				{ t: "letter", id: "l3", organization_id: "o-2" },
				{ t: "letter", id: "l4", organization_id: backfilledId },
				{ t: "version", id: "v1", organization_id: "o-old" },
				{ t: "version", id: "v2", organization_id: "o-old" },
				{ t: "version", id: "v3", organization_id: "o-2" },
				{ t: "version", id: "v4", organization_id: backfilledId },
			]);

			// RLS is enabled and forced with both policies on both tables, the column is NOT NULL, and the guest-link
			// function exists for careeros_app only (PUBLIC cannot execute it).
			const rls = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
				`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = 'r' ORDER BY relname`,
				[TABLES],
			);
			expect(rls).toHaveLength(2);
			for (const row of rls)
				expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
			const policies = await q<{ policyname: string; qual: string; with_check: string }>(
				`SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = ANY($1) ORDER BY tablename, policyname`,
				[TABLES],
			);
			expect(policies.map((p) => p.policyname)).toEqual([
				"owner_access",
				"tenant_isolation",
				"owner_access",
				"tenant_isolation",
			]);
			for (const policy of policies.filter((p) => p.policyname === "tenant_isolation")) {
				expect(policy.qual).toContain("current_setting('app.current_org_id'");
				expect(policy.with_check).toContain("current_setting('app.current_org_id'");
			}
			expect(
				await q(
					`SELECT table_name FROM information_schema.columns WHERE column_name = 'organization_id' AND is_nullable = 'YES' AND table_name = ANY($1)`,
					[TABLES],
				),
			).toEqual([]);
			expect(await q(`SELECT prosecdef FROM pg_proc WHERE proname = 'careeros_move_guest_cover_letters'`)).toEqual([
				{ prosecdef: true },
			]);

			// A second run changes nothing.
			await q(migration);
			expect(await snapshot()).toEqual(first);

			// Down: policies, function, columns and indexes of the two tables go; the letters stay.
			await q(down);
			expect(
				await q(
					`SELECT table_name FROM information_schema.columns WHERE column_name = 'organization_id' AND table_name = ANY($1)`,
					[TABLES],
				),
			).toEqual([]);
			expect(await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ANY($1)`, [TABLES])).toEqual([
				{ n: 0 },
			]);
			expect(
				await q(`SELECT relname FROM pg_class WHERE relname = ANY($1) AND (relrowsecurity OR relforcerowsecurity)`, [
					TABLES,
				]),
			).toEqual([]);
			expect(
				await q(
					`SELECT proname FROM pg_proc WHERE proname IN ('careeros_move_guest_cover_letters', 'careeros_orgs_with_expired_trash')`,
				),
			).toEqual([]);
			expect(await q(`SELECT indexname FROM pg_indexes WHERE indexname LIKE 'cover_letter%organization_id%'`)).toEqual(
				[],
			);
			expect(await q(`SELECT id FROM cover_letter ORDER BY id`)).toEqual([
				{ id: "l1" },
				{ id: "l2" },
				{ id: "l3" },
				{ id: "l4" },
			]);
			expect(await q(`SELECT id FROM cover_letter_version ORDER BY id`)).toEqual([
				{ id: "v1" },
				{ id: "v2" },
				{ id: "v3" },
				{ id: "v4" },
			]);

			// And up again from the restored state gives the same result as the first run.
			await q(migration);
			expect((await snapshot()).rows).toEqual(first.rows);
		} finally {
			await closePool?.().catch(() => undefined);
			await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
			await admin.end();
			await rm(baselineFolder, { recursive: true, force: true });
		}
	}, 120_000);
});
