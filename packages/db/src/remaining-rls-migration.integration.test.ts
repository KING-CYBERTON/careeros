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

// CAREEROS (P1-T09): the migration for custom_domain, storage_cleanup_job and web_access_credentials on a database that
// already holds rows. Applies every migration before it, seeds rows for users with one, two and no organization (and
// erasure work whose owner is gone), runs the migration, runs it a second time, then the down migration (which must
// refuse while it would lose data) and the migration again. Needs CREATE DATABASE permission; owns and deletes one
// disposable database, never the supplied one.
const migrationsFolder = fileURLToPath(new URL("../../../migrations", import.meta.url));
const md5Of = (value: string) => createHash("md5").update(value).digest("hex");
const FOLDER = "20261101083301_remaining_rls";
const TABLES = ["custom_domain", "storage_cleanup_job", "web_access_credentials"];

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("remaining tables tenancy migration", () => {
	it("backfills organization ids, is idempotent, enables forced RLS, refuses a lossy down, and reverses", async () => {
		const databaseUrl = process.env.COVER_LETTER_TEST_DATABASE_URL;
		if (!databaseUrl) throw new Error("COVER_LETTER_TEST_DATABASE_URL is required");
		const admin = new Pool({ connectionString: databaseUrl });
		const baselineFolder = await mkdtemp(path.join(tmpdir(), "careeros-t09-migrations-"));
		const databaseName = `migration_t09_${randomUUID().replaceAll("-", "")}`;
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

			// Before: u1 belongs to two organizations (the older one wins), u2 to one, u3 to none but has a domain, u4 has
			// nothing, u5 has no organization and only erasure work, "ghost" no longer exists.
			for (const id of ["u1", "u2", "u3", "u4", "u5"]) {
				await q(`INSERT INTO "user" (id,name,email,username,display_username) VALUES ($1,$1,$1||'@x.test',$1,$1)`, [
					id,
				]);
			}
			await q(
				`INSERT INTO organization (id,name,slug) VALUES ('o-old','Old','o-old'),('o-new','New','o-new'),('o-2','Two','o-2')`,
			);
			await q(`INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES
				('m1a','o-new','u1','member','2026-02-01'),('m1b','o-old','u1','owner','2026-01-01'),('m2','o-2','u2','owner','2026-01-01')`);
			await q(`INSERT INTO custom_domain (user_id,hostname,verification_token,verified_at) VALUES
				('u1','one.example.test','t1',now()),('u2','two.example.test','t2',NULL),('u3','three.example.test','t3',NULL)`);
			await q(`INSERT INTO web_access_credentials (user_id,provider,encrypted_api_key) VALUES
				('u1','exa','k1'),('u2','tavily','k2')`);
			await q(`INSERT INTO storage_cleanup_job (id,owner_id,storage_key) VALUES
				('j1','u1','uploads/u1/a'),('j2','u2','uploads/u2/a'),('j3','u5','uploads/u5/a'),('j4','ghost','uploads/ghost')`);

			const migration = await readFile(path.join(migrationsFolder, FOLDER, "migration.sql"), "utf8");
			const down = await readFile(path.join(migrationsFolder, FOLDER, "down.sql"), "utf8");
			const snapshot = async () => ({
				organizations: await q(`SELECT id,name,slug,metadata FROM organization ORDER BY id`),
				members: await q(`SELECT id,organization_id,user_id,role FROM member ORDER BY id`),
				rows: await q(`SELECT 'domain' AS t,user_id AS id,organization_id FROM custom_domain UNION ALL
					SELECT 'credential',user_id,organization_id FROM web_access_credentials UNION ALL
					SELECT 'job',id,organization_id FROM storage_cleanup_job ORDER BY 1,2`),
			});

			await q(migration);
			const first = await snapshot();

			// u3 (domain) and u5 (erasure work) got personal organizations; u4 (nothing) did not.
			const bf = (user: string) => `bf_${md5Of(user)}`;
			expect(first.organizations.filter((o) => o.metadata === '{"careeros_backfill":true}').map((o) => o.id)).toEqual(
				[bf("u3"), bf("u5")].sort(),
			);
			expect(first.members.filter((m) => m.user_id === "u4")).toEqual([]);
			// Rows take the owner's oldest membership; erasure work of a user without one takes the personal organization;
			// work whose owner is gone takes the sentinel.
			expect(first.rows).toEqual([
				{ t: "credential", id: "u1", organization_id: "o-old" },
				{ t: "credential", id: "u2", organization_id: "o-2" },
				{ t: "domain", id: "u1", organization_id: "o-old" },
				{ t: "domain", id: "u2", organization_id: "o-2" },
				{ t: "domain", id: "u3", organization_id: bf("u3") },
				{ t: "job", id: "j1", organization_id: "o-old" },
				{ t: "job", id: "j2", organization_id: "o-2" },
				{ t: "job", id: "j3", organization_id: bf("u5") },
				{ t: "job", id: "j4", organization_id: "careeros_orphan" },
			]);
			// The sentinel has no organization row, and the job table has no foreign key to organization.
			expect(await q(`SELECT id FROM organization WHERE id = 'careeros_orphan'`)).toEqual([]);
			expect(
				await q(`SELECT 1 FROM pg_constraint WHERE conrelid = 'storage_cleanup_job'::regclass AND contype = 'f'`),
			).toEqual([]);

			// RLS is enabled and forced with both policies on all three tables, the column is NOT NULL, the keys are
			// organization-led, and the functions are definers.
			const rls = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
				`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = 'r' ORDER BY relname`,
				[TABLES],
			);
			expect(rls).toHaveLength(3);
			for (const row of rls)
				expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
			const policies = await q<{ policyname: string; qual: string; with_check: string }>(
				`SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = ANY($1) ORDER BY tablename, policyname`,
				[TABLES],
			);
			expect(policies.map((p) => p.policyname)).toEqual(Array(3).fill(["owner_access", "tenant_isolation"]).flat());
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
			expect(
				await q<{ conrelid: string; columns: string[] }>(
					`SELECT conrelid::regclass::text AS conrelid, array_agg(a.attname::text ORDER BY array_position(c.conkey, a.attnum)) AS columns
					   FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
					  WHERE c.conrelid = ANY(ARRAY['custom_domain'::regclass, 'web_access_credentials'::regclass]) AND c.contype = 'p'
					  GROUP BY c.conrelid ORDER BY 1`,
				),
			).toEqual([
				{ conrelid: "custom_domain", columns: ["organization_id", "user_id"] },
				{ conrelid: "web_access_credentials", columns: ["organization_id", "user_id"] },
			]);
			const functions = [
				"careeros_public_domain_owner",
				"careeros_verified_domains",
				"careeros_public_verified_domain",
				"careeros_release_domain_claims",
				"careeros_stale_custom_domains",
				"careeros_due_storage_cleanup",
				"careeros_guest_cleanup_prefixes",
				"enqueue_account_storage_cleanup",
			];
			expect(
				await q(`SELECT proname, prosecdef FROM pg_proc WHERE proname = ANY($1) ORDER BY proname`, [functions]),
			).toEqual(functions.toSorted().map((proname) => ({ proname, prosecdef: true })));
			// The verified-hostname index stays global.
			expect(await q(`SELECT indexdef FROM pg_indexes WHERE indexname = 'custom_domain_verified_hostname'`)).toEqual([
				{ indexdef: expect.stringContaining("(hostname) WHERE (verified_at IS NOT NULL)") },
			]);

			// A second run changes nothing.
			await q(migration);
			expect(await snapshot()).toEqual(first);

			// The account delete trigger files work under the sentinel when no organization is set, and under the
			// session's organization when one is.
			await q(`DELETE FROM "user" WHERE id = 'u4'`);
			expect(await q(`SELECT organization_id FROM storage_cleanup_job WHERE owner_id = 'u4'`)).toEqual([
				{ organization_id: "careeros_orphan" },
			]);
			await q(`SELECT set_config('app.current_org_id', 'o-2', false)`);
			await q(`DELETE FROM "user" WHERE id = 'u2'`);
			await q(`SELECT set_config('app.current_org_id', '', false)`);
			expect(await q(`SELECT organization_id FROM storage_cleanup_job WHERE owner_id = 'u2'`)).toEqual([
				{ organization_id: "o-2" },
			]);

			// Down refuses, and changes nothing, while a user holds a domain in two organizations.
			await q(
				`INSERT INTO custom_domain (organization_id,user_id,hostname,verification_token) VALUES ('o-new','u1','dup.example.test','t')`,
			);
			await expect(q(down)).rejects.toThrow(/down refused/);
			expect(
				await q(
					`SELECT column_name FROM information_schema.columns WHERE table_name = 'custom_domain' AND column_name = 'organization_id'`,
				),
			).toHaveLength(1);
			expect(await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ANY($1)`, [TABLES])).toEqual([
				{ n: 6 },
			]);
			await q(`DELETE FROM custom_domain WHERE hostname = 'dup.example.test'`);

			// Down: policies, functions, columns and keys go; the rows stay (u2 was deleted above, with its rows).
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
			const remaining = functions.filter((name) => name !== "enqueue_account_storage_cleanup");
			expect(await q(`SELECT proname FROM pg_proc WHERE proname = ANY($1)`, [remaining])).toEqual([]);
			expect(await q(`SELECT user_id FROM custom_domain ORDER BY user_id`)).toEqual([
				{ user_id: "u1" },
				{ user_id: "u3" },
			]);
			// The old trigger function works again (no organization column to fill).
			await q(`DELETE FROM "user" WHERE id = 'u5'`);
			expect(await q(`SELECT id FROM storage_cleanup_job WHERE owner_id = 'u5' AND id = 'u5:account'`)).toEqual([
				{ id: "u5:account" },
			]);
			await q(`DELETE FROM storage_cleanup_job WHERE owner_id = 'u5'`);

			// And up again from the restored state backfills the same way.
			await q(migration);
			const again = (await snapshot()).rows.filter((row) => row.t !== "job");
			expect(again).toEqual(first.rows.filter((row) => row.t !== "job" && row.id !== "u2"));
		} finally {
			await closePool?.().catch(() => undefined);
			await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
			await admin.end();
			await rm(baselineFolder, { recursive: true, force: true });
		}
	}, 120_000);
});
