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

// CAREEROS (P1-T07): the career tenant migration on a database that already holds career data. Applies every migration
// before it (including P1-T04 to P1-T06), seeds career rows for users with one, two and no organization, runs the
// migration, runs it a second time, checks the backfill, the new keys, the workspace foreign key and the scheduler
// functions, then runs the down migration (which must refuse while a user has rows in two organizations) and the
// migration again. Needs CREATE DATABASE permission; owns and deletes one disposable database, never the supplied one.
const migrationsFolder = fileURLToPath(new URL("../../../migrations", import.meta.url));
const md5Of = (value: string) => createHash("md5").update(value).digest("hex");
const FOLDER = "20261101083119_career_rls";
const TABLES = [
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

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("career tenancy migration", () => {
	it("backfills organization ids, changes the keys, is idempotent, enables forced RLS, and reverses", async () => {
		const databaseUrl = process.env.COVER_LETTER_TEST_DATABASE_URL;
		if (!databaseUrl) throw new Error("COVER_LETTER_TEST_DATABASE_URL is required");
		const admin = new Pool({ connectionString: databaseUrl });
		const baselineFolder = await mkdtemp(path.join(tmpdir(), "careeros-t07-migrations-"));
		const databaseName = `migration_t07_${randomUUID().replaceAll("-", "")}`;
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

			// Before: u1 belongs to two organizations (the older one wins unless a row is linked to an application), u2
			// to one, u3 to none but has a career profile, u4 has nothing at all.
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
			// a1 is u1's application in the NEWER organization: everything linked to it must follow it there.
			await q(
				`INSERT INTO application (id,organization_id,user_id,company,role) VALUES ('a1','o-new','u1','C1','R'),('a3','o-2','u2','C3','R')`,
			);
			await q(
				`INSERT INTO career_schedule (id,user_id,application_id,kind,next_run_at) VALUES ('s1','u1','a1','follow-up',now()),('s2','u1',NULL,'discovery',now())`,
			);
			await q(
				`INSERT INTO career_job (id,user_id,schedule_id,due_at) VALUES ('j1','u1','s1',now()),('j2','u1','s2',now())`,
			);
			await q(
				`INSERT INTO career_fact (id,user_id,application_id,text,category,source,source_key) VALUES
				('f1','u1','a1','x','skill','{}','k1'),('f2','u1',NULL,'x','skill','{}','k2'),('f3','u2',NULL,'x','skill','{}','k2')`,
			);
			await q(`INSERT INTO career_story (id,user_id,data) VALUES ('st1','u2','{}')`);
			await q(
				`INSERT INTO career_artifact (id,user_id,application_id,job_id,title,data,evidence,input_version) VALUES
				('art1','u1',NULL,'j1','t','{}','{}','v'),('art2','u1',NULL,NULL,'t','{}','{}','v')`,
			);
			await q(`INSERT INTO career_workspace (application_id,user_id,data) VALUES ('a1','u1','{}'),('a3','u2','{}')`);
			await q(`INSERT INTO career_profile (user_id,data) VALUES ('u1','{}'),('u3','{}')`);
			await q(
				`INSERT INTO career_answer (id,user_id,question,answer,source,scope,employer,application_id,source_application_id,fact_ids,story_ids,evidence,reviewed_at,duplicate_key)
				 VALUES ('ans1','u1','q','a','manual','reusable','',NULL,'a1','[]','[]','[]',now(),'d1'),('ans2','u1','q','a','manual','reusable','',NULL,NULL,'[]','[]','[]',now(),'d2')`,
			);
			await q(
				`INSERT INTO career_opportunity (id,user_id,url,snippet,tracked_application_id) VALUES ('opp1','u1','https://x.test/1','s','a1'),('opp2','u1','https://x.test/2','s',NULL)`,
			);
			await q(
				`INSERT INTO career_notification (id,user_id,application_id,key,notice) VALUES ('n1','u1','a1','k','{}'),('n2','u1',NULL,'k2','{}')`,
			);
			await q(
				`INSERT INTO career_transcript (id,user_id,application_id,original,edited,model) VALUES ('t1','u1','a1','a','a','m')`,
			);

			const migration = await readFile(path.join(migrationsFolder, FOLDER, "migration.sql"), "utf8");
			const down = await readFile(path.join(migrationsFolder, FOLDER, "down.sql"), "utf8");
			const idColumn = (table: string) =>
				table === "career_profile" ? "user_id" : table === "career_workspace" ? "application_id" : "id";
			const snapshot = async () => ({
				organizations: await q(`SELECT id,name,slug,metadata FROM organization ORDER BY id`),
				members: await q(`SELECT id,organization_id,user_id,role FROM member ORDER BY id`),
				rows: await q(
					TABLES.map((t) => `SELECT '${t}' AS t, ${idColumn(t)}::text AS id, organization_id, user_id FROM ${t}`).join(
						" UNION ALL ",
					) + " ORDER BY 1,2,3",
				),
			});
			const countAll = async () =>
				Object.fromEntries(
					await Promise.all(
						TABLES.map(
							async (t) => [t, (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0]?.n] as const,
						),
					),
				);
			const before = await countAll();

			await q(migration);
			const first = await snapshot();

			// u3 (a profile, no membership) got a personal organization; u4 (nothing) did not. T04's rule for ids.
			const personal = `bf_${md5Of("u3")}`;
			expect(first.organizations.filter((o) => o.metadata === '{"careeros_backfill":true}').map((o) => o.id)).toEqual([
				personal,
			]);
			expect(first.members.filter((m) => m.user_id === "u4")).toEqual([]);
			expect(first.members.filter((m) => m.user_id === "u3")).toEqual([
				{ id: personal, organization_id: personal, user_id: "u3", role: "owner" },
			]);

			// Linked rows take their application's organization (also through a schedule, a job and a source application);
			// everything else takes the owner's oldest membership.
			const orgOf = (table: string, id: string) =>
				first.rows.find((row) => row.t === table && row.id === id)?.organization_id;
			const expectedOrgs: [string, string, string][] = [
				["career_schedule", "s1", "o-new"],
				["career_schedule", "s2", "o-old"],
				["career_job", "j1", "o-new"],
				["career_job", "j2", "o-old"],
				["career_fact", "f1", "o-new"],
				["career_fact", "f2", "o-old"],
				["career_fact", "f3", "o-2"],
				["career_story", "st1", "o-2"],
				["career_artifact", "art1", "o-new"],
				["career_artifact", "art2", "o-old"],
				["career_workspace", "a1", "o-new"],
				["career_workspace", "a3", "o-2"],
				["career_profile", "u1", "o-old"],
				["career_profile", "u3", personal],
				["career_answer", "ans1", "o-new"],
				["career_answer", "ans2", "o-old"],
				["career_opportunity", "opp1", "o-new"],
				["career_opportunity", "opp2", "o-old"],
				["career_notification", "n1", "o-new"],
				["career_notification", "n2", "o-old"],
				["career_transcript", "t1", "o-new"],
			];
			for (const [table, id, org] of expectedOrgs) expect(orgOf(table, id), `${table} ${id}`).toBe(org);
			// Nothing else changed: the same rows in every table.
			expect(await countAll()).toEqual(before);

			// RLS is enabled and forced with both policies on all eleven tables, the column is NOT NULL, and the definer
			// functions exist; the interim T06 scheduler functions are gone.
			const rls = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
				`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = 'r' ORDER BY relname`,
				[TABLES],
			);
			expect(rls).toHaveLength(TABLES.length);
			for (const row of rls)
				expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
			const policies = await q<{ policyname: string; qual: string; with_check: string }>(
				`SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = ANY($1) ORDER BY tablename, policyname`,
				[TABLES],
			);
			expect(policies.map((p) => p.policyname)).toEqual(
				Array(TABLES.length).fill(["owner_access", "tenant_isolation"]).flat(),
			);
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
			const functions = [
				"careeros_move_guest_career",
				"careeros_due_career_jobs",
				"careeros_orgs_with_due_career_schedules",
				"careeros_orgs_with_career_upkeep",
			];
			const interim = ["careeros_application_is_open", "careeros_application_org"];
			expect(
				await q(`SELECT proname, prosecdef FROM pg_proc WHERE proname = ANY($1) ORDER BY proname`, [functions]),
			).toEqual(functions.toSorted().map((proname) => ({ proname, prosecdef: true })));
			expect(await q(`SELECT proname FROM pg_proc WHERE proname = ANY($1)`, [interim])).toEqual([]);

			// D11: keys are per (organization, user). The profile can exist once per organization, not twice in one.
			const keyColumns = async (table: string, type: "p" | "u") =>
				(
					await q<{ conname: string; columns: string[] }>(
						`SELECT c.conname, array_agg(a.attname::text ORDER BY k.ord) AS columns FROM pg_constraint c
						 CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
						 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
						 WHERE c.conrelid = $1::regclass AND c.contype = $2 GROUP BY c.conname ORDER BY c.conname`,
						[table, type],
					)
				).map((row) => ({ name: row.conname, columns: row.columns }));
			expect(await keyColumns("career_profile", "p")).toEqual([
				{ name: "career_profile_pkey", columns: ["organization_id", "user_id"] },
			]);
			expect(await keyColumns("career_workspace", "p")).toEqual([
				{ name: "career_workspace_pkey", columns: ["application_id"] },
			]);
			const uniqueIndexColumns = async (table: string) =>
				(
					await q<{ indexdef: string }>(
						`SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexdef LIKE 'CREATE UNIQUE%' AND indexname NOT LIKE '%pkey' ORDER BY indexname`,
						[table],
					)
				).map((row) => /\(([^)]+)\)/.exec(row.indexdef)?.[1]);
			expect(await uniqueIndexColumns("career_fact")).toEqual(["organization_id, user_id, source_key"]);
			expect(await uniqueIndexColumns("career_notification")).toEqual(["organization_id, user_id, key"]);
			expect(await uniqueIndexColumns("career_opportunity")).toEqual(["organization_id, user_id, url"]);
			expect(await uniqueIndexColumns("career_answer")).toEqual(["organization_id, user_id, duplicate_key"]);
			await q(`INSERT INTO career_profile (organization_id,user_id,data) VALUES ('o-new','u1','{}')`);
			await q(
				`INSERT INTO career_fact (id,organization_id,user_id,text,category,source,source_key) VALUES ('f4','o-new','u1','x','skill','{}','k2')`,
			);
			await expect(
				q(`INSERT INTO career_profile (organization_id,user_id,data) VALUES ('o-old','u1','{}')`),
			).rejects.toMatchObject({ code: "23505" });
			await expect(
				q(
					`INSERT INTO career_fact (id,organization_id,user_id,text,category,source,source_key) VALUES ('f5','o-old','u1','x','skill','{}','k2')`,
				),
			).rejects.toMatchObject({ code: "23505" });
			// The workspace's organization must equal its application's.
			await expect(
				q(`INSERT INTO career_workspace (application_id,organization_id,user_id,data) VALUES ('a3','o-old','u2','{}')`),
			).rejects.toMatchObject({ code: "23505" });
			await q(`INSERT INTO application (id,organization_id,user_id,company,role) VALUES ('a8','o-2','u2','C8','R')`);
			await expect(
				q(`INSERT INTO career_workspace (application_id,organization_id,user_id,data) VALUES ('a8','o-old','u2','{}')`),
			).rejects.toMatchObject({ code: "23503" });
			await q(`DELETE FROM application WHERE id = 'a8'`);

			// A second run changes nothing it already did (the rows added above stay as they are).
			const second = await snapshot();
			await q(migration);
			expect(await snapshot()).toEqual(second);

			// Down refuses while a user has rows in two organizations, and then changes nothing.
			await expect(q(down)).rejects.toMatchObject({ message: expect.stringContaining("more than one organization") });
			expect(await snapshot()).toEqual(second);
			for (const table of TABLES) await q(`DELETE FROM ${table} WHERE organization_id = 'o-new'`);
			await q(`DELETE FROM application WHERE id = 'a1'`);
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
			expect(await q(`SELECT proname FROM pg_proc WHERE proname = ANY($1)`, [functions])).toEqual([]);
			expect(await q(`SELECT proname FROM pg_proc WHERE proname = ANY($1) ORDER BY proname`, [interim])).toEqual([
				{ proname: "careeros_application_is_open" },
				{ proname: "careeros_application_org" },
			]);
			expect(await keyColumns("career_profile", "p")).toEqual([{ name: "career_profile_pkey", columns: ["user_id"] }]);
			expect(await uniqueIndexColumns("career_fact")).toEqual(["user_id, source_key"]);
			expect(await uniqueIndexColumns("career_answer")).toEqual(["user_id, duplicate_key"]);
			expect(
				await q(
					`SELECT conname FROM pg_constraint WHERE conrelid = 'career_workspace'::regclass AND contype = 'f' ORDER BY conname`,
				),
			).toEqual([
				{ conname: "career_workspace_application_id_application_id_fkey" },
				{ conname: "career_workspace_user_id_user_id_fkey" },
			]);
			expect(
				await q(`SELECT conname FROM pg_constraint WHERE conname = 'application_organization_id_id_unique'`),
			).toEqual([]);
			expect(await q(`SELECT indexname FROM pg_indexes WHERE indexname LIKE 'career%organization_id%'`)).toEqual([]);

			// And up again from the restored state gives the same rows as the first run, minus the deleted ones.
			await q(migration);
			const again = await snapshot();
			expect(again.rows).toEqual(first.rows.filter((row) => row.organization_id !== "o-new"));
		} finally {
			await closePool?.().catch(() => undefined);
			await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
			await admin.end();
			await rm(baselineFolder, { recursive: true, force: true });
		}
	}, 120_000);
});
