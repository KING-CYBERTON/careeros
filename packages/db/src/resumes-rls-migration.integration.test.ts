import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// CAREEROS (P1-T04): the resume tenant migration on a database that already holds data. Seeds two users without an
// organization, one with an existing membership, and resumes with versions, redirects and statistics; runs the
// migration; runs it a second time; then runs the down migration. Needs CREATE DATABASE permission; owns and deletes
// one disposable database, never the supplied one.
const migrationsFolder = fileURLToPath(new URL("../../../migrations", import.meta.url));
const md5Of = (value: string) => createHash("md5").update(value).digest("hex");
const FOLDER = "20261101004553_resumes_rls";
const TABLES = ["resume", "resume_version", "resume_slug_redirect", "resume_statistics", "resume_statistics_daily"];

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("resume tenancy migration", () => {
	it("backfills organizations and organization ids, is idempotent, enables forced RLS, and reverses", async () => {
		const databaseUrl = process.env.COVER_LETTER_TEST_DATABASE_URL;
		if (!databaseUrl) throw new Error("COVER_LETTER_TEST_DATABASE_URL is required");
		const admin = new Pool({ connectionString: databaseUrl });
		const baselineFolder = await mkdtemp(path.join(tmpdir(), "careeros-t04-migrations-"));
		const databaseName = `migration_t04_${randomUUID().replaceAll("-", "")}`;
		let pool: Pool | undefined;
		try {
			for (const name of await readdir(migrationsFolder)) {
				if (name < FOLDER) await symlink(path.join(migrationsFolder, name), path.join(baselineFolder, name));
			}
			await admin.query(`CREATE DATABASE "${databaseName}"`);
			const url = new URL(databaseUrl);
			url.pathname = `/${databaseName}`;
			pool = new Pool({ connectionString: url.toString(), max: 1 });
			await migrate(drizzle({ client: pool }), { migrationsFolder: baselineFolder });
			const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
				(await (pool as Pool).query<T>(sql, params)).rows;

			// Before: u1 and u2 have no organization; u3 already belongs to one (and keeps it).
			for (const id of ["u1", "u2", "u3"]) {
				await q(`INSERT INTO "user" (id,name,email,username,display_username) VALUES ($1,$1,$1||'@x.test',$1,$1)`, [
					id,
				]);
			}
			await q(`INSERT INTO "user" (id,name,email,username,display_username) VALUES ('u4',' ','u4@x.test','  ','  ')`);
			await q(`INSERT INTO organization (id,name,slug) VALUES ('existing','Existing','existing')`);
			await q(`INSERT INTO member (id,organization_id,user_id,role) VALUES ('m3','existing','u3','member')`);
			for (const [id, userId] of [
				["s1", "u1"],
				["s3", "u3"],
			] as const) {
				await q(`INSERT INTO session (id,token,user_id,expires_at) VALUES ($1,$1,$2,now() + interval '1 day')`, [
					id,
					userId,
				]);
			}
			await q(
				`INSERT INTO session (id,token,user_id,expires_at,active_organization_id) VALUES ('s3b','s3b','u3',now() + interval '1 day','existing')`,
			);
			// API keys: k1 has no organization (gets u3's), k2 already has one (kept), k3 belongs to a user without a membership
			// until the backfill gives them one.
			await q(
				`INSERT INTO apikey (id,key,reference_id,organization_id) VALUES ('k1','k1','u3',NULL),('k2','k2','u3','other'),('k3','k3','u1',NULL)`,
			);
			await q(`INSERT INTO resume (id,name,slug,data,user_id) VALUES
				('r1','R1','r1','{}','u1'),('r2','R2','r2','{}','u1'),('r3','R3','r3','{}','u2'),('r4','R4','r4','{}','u3')`);
			await q(
				`INSERT INTO resume_version (id,resume_id,user_id,data) VALUES ('v1','r1','u1','{}'),('v4','r4','u3','{}')`,
			);
			await q(
				`INSERT INTO resume_slug_redirect (id,slug,resume_id,user_id,expires_at) VALUES ('d1','old','r2','u1',now() + interval '1 day')`,
			);
			await q(`INSERT INTO resume_statistics (id,resume_id) VALUES ('st1','r1')`);
			await q(`INSERT INTO resume_statistics_daily (id,resume_id,date) VALUES ('sd1','r1',current_date)`);

			const migration = await readFile(path.join(migrationsFolder, FOLDER, "migration.sql"), "utf8");
			const down = await readFile(path.join(migrationsFolder, FOLDER, "down.sql"), "utf8");
			const snapshot = async () => ({
				organizations: await q(`SELECT id,name,slug,metadata FROM organization ORDER BY id`),
				members: await q(`SELECT id,organization_id,user_id,role FROM member ORDER BY id`),
				sessions: await q(`SELECT id,active_organization_id FROM session ORDER BY id`),
				rows: await q(`SELECT 'resume' AS t,id,organization_id FROM resume UNION ALL SELECT 'version',id,organization_id FROM resume_version
					UNION ALL SELECT 'redirect',id,organization_id FROM resume_slug_redirect UNION ALL SELECT 'stats',id,organization_id FROM resume_statistics
					UNION ALL SELECT 'daily',id,organization_id FROM resume_statistics_daily ORDER BY 1,2`),
			});

			await q(migration);
			const first = await snapshot();

			// Every user has exactly one organization; the existing membership is untouched.
			const backfilled = first.organizations.filter((o) => o.metadata === '{"careeros_backfill":true}');
			expect(backfilled).toHaveLength(3);
			expect(backfilled.find((o) => o.id === `bf_${md5Of("u4")}`)?.name).toBe("Personal workspace");
			const keys = await q(`SELECT id, organization_id FROM apikey ORDER BY id`);
			expect(keys).toEqual([
				{ id: "k1", organization_id: "existing" },
				{ id: "k2", organization_id: "other" },
				{ id: "k3", organization_id: first.members.find((m) => m.user_id === "u1")?.organization_id },
			]);
			expect(first.members.filter((m) => m.user_id === "u3")).toEqual([
				{ id: "m3", organization_id: "existing", user_id: "u3", role: "member" },
			]);
			const orgOf = (userId: string) => first.members.find((m) => m.user_id === userId)?.organization_id;
			expect(first.members.filter((m) => m.user_id === "u1" || m.user_id === "u2").map((m) => m.role)).toEqual([
				"owner",
				"owner",
			]);
			expect(orgOf("u1")).not.toBe(orgOf("u2"));
			// Sessions without an active organization get the user's; an existing choice is kept.
			expect(first.sessions).toEqual([
				{ id: "s1", active_organization_id: orgOf("u1") },
				{ id: "s3", active_organization_id: "existing" },
				{ id: "s3b", active_organization_id: "existing" },
			]);
			// Every row has its owner's organization; child rows follow their resume.
			expect(first.rows).toEqual([
				{ t: "daily", id: "sd1", organization_id: orgOf("u1") },
				{ t: "redirect", id: "d1", organization_id: orgOf("u1") },
				{ t: "resume", id: "r1", organization_id: orgOf("u1") },
				{ t: "resume", id: "r2", organization_id: orgOf("u1") },
				{ t: "resume", id: "r3", organization_id: orgOf("u2") },
				{ t: "resume", id: "r4", organization_id: "existing" },
				{ t: "stats", id: "st1", organization_id: orgOf("u1") },
				{ t: "version", id: "v1", organization_id: orgOf("u1") },
				{ t: "version", id: "v4", organization_id: "existing" },
			]);

			// RLS is enabled and forced with the tenant policy on all five tables, and the column is NOT NULL.
			const rls = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
				`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = 'r' ORDER BY relname`,
				[TABLES],
			);
			expect(rls).toHaveLength(5);
			for (const row of rls)
				expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
			const policies = await q<{ tablename: string; policyname: string; qual: string; with_check: string }>(
				`SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE tablename = ANY($1) AND policyname = 'tenant_isolation'`,
				[TABLES],
			);
			expect(policies).toHaveLength(5);
			for (const policy of policies) {
				expect(policy.qual).toContain("current_setting('app.current_org_id'");
				expect(policy.with_check).toContain("current_setting('app.current_org_id'");
			}
			const nullable = await q(
				`SELECT table_name FROM information_schema.columns WHERE column_name = 'organization_id' AND is_nullable = 'YES' AND table_name = ANY($1)`,
				[TABLES],
			);
			expect(nullable).toEqual([]);

			// A second run changes nothing.
			await q(migration);
			expect(await snapshot()).toEqual(first);

			// Down: policies, functions, columns and the backfilled organizations go; data and prior organizations stay.
			await q(down);
			expect(await q(`SELECT id FROM organization ORDER BY id`)).toEqual([{ id: "existing" }]);
			expect(await q(`SELECT id,organization_id FROM member ORDER BY id`)).toEqual([
				{ id: "m3", organization_id: "existing" },
			]);
			expect(await q(`SELECT id,active_organization_id FROM session ORDER BY id`)).toEqual([
				{ id: "s1", active_organization_id: null },
				{ id: "s3", active_organization_id: "existing" },
				{ id: "s3b", active_organization_id: "existing" },
			]);
			expect(
				await q(
					`SELECT table_name FROM information_schema.columns WHERE column_name = 'organization_id' AND table_name = ANY($1)`,
					[TABLES],
				),
			).toEqual([]);
			expect(await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ANY($1)`, [TABLES])).toEqual([
				{ n: 0 },
			]);
			expect(await q(`SELECT proname FROM pg_proc WHERE proname LIKE 'careeros\\_%'`)).toEqual([]);
			expect(await q(`SELECT id FROM resume ORDER BY id`)).toEqual([
				{ id: "r1" },
				{ id: "r2" },
				{ id: "r3" },
				{ id: "r4" },
			]);
			expect(await q(`SELECT id FROM resume_version ORDER BY id`)).toEqual([{ id: "v1" }, { id: "v4" }]);

			// And up again from the restored state gives the same result as the first run.
			await q(migration);
			const again = await snapshot();
			expect(again.rows).toEqual(first.rows);
		} finally {
			await pool?.end().catch(() => undefined);
			await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
			await admin.end();
			await rm(baselineFolder, { recursive: true, force: true });
		}
	}, 120_000);
});
