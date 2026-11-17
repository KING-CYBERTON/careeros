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

// CAREEROS (P1-T08): the assistant and AI tenant migration on a database that already holds such data. Applies every
// migration before it (including P1-T04 to P1-T07), seeds saved connections, conversations and reports for users with
// one, two and no organization, runs the migration, runs it a second time, checks the backfill, the cleared cross-
// organization links, the renamed server connection, the new keys and the composite foreign keys, then runs the down
// migration (which must refuse while a user has rows in two organizations) and the migration again. Needs CREATE
// DATABASE permission; owns and deletes one disposable database, never the supplied one.
const migrationsFolder = fileURLToPath(new URL("../../../migrations", import.meta.url));
const md5Of = (value: string) => createHash("md5").update(value).digest("hex");
const FOLDER = "20261101085357_agent_ai_rls";
const TABLES = [
	"ai_providers",
	"agent_threads",
	"agent_messages",
	"agent_attachments",
	"agent_actions",
	"ai_content_report",
];
const KEY = "encrypted_api_key,api_key_salt,api_key_hash,api_key_preview";

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("assistant and AI tenancy migration", () => {
	it("backfills organization ids, changes the keys, is idempotent, enables forced RLS, and reverses", async () => {
		const databaseUrl = process.env.COVER_LETTER_TEST_DATABASE_URL;
		if (!databaseUrl) throw new Error("COVER_LETTER_TEST_DATABASE_URL is required");
		const admin = new Pool({ connectionString: databaseUrl });
		const baselineFolder = await mkdtemp(path.join(tmpdir(), "careeros-t08-migrations-"));
		const databaseName = `migration_t08_${randomUUID().replaceAll("-", "")}`;
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

			// Before: u1 belongs to two organizations (the older one wins unless a row is linked to a document or an
			// application), u2 to one, u3 to none but has a connection, u4 has nothing at all.
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
			await q(`INSERT INTO resume (id,name,slug,data,user_id,organization_id) VALUES ('r1','R','r','{}','u1','o-new')`);
			await q(`INSERT INTO application (id,organization_id,user_id,company,role) VALUES ('a1','o-new','u1','C1','R')`);
			await q(`INSERT INTO ai_providers (id,user_id,label,provider,model,${KEY},is_default) VALUES
				('p1','u1','P','openai','m','e','s','h','p',true),
				('server-ai:u1','u1','Server AI','openai','m','','','','',false),
				('p2','u2','P','openai','m','e','s','h','p',false),
				('p3','u3','P','openai','m','e','s','h','p',false)`);
			await q(`INSERT INTO agent_threads (id,user_id,ai_provider_id,working_resume_id,application_id,scope,title) VALUES
				('t1','u1','p1','r1',NULL,'document','document in the newer organization, connection in the older'),
				('t2','u1','server-ai:u1',NULL,NULL,'document','server connection'),
				('t3','u2','p2',NULL,NULL,'document','plain'),
				('t4','u1',NULL,NULL,'a1','application','application'),
				('t5','u3','p3',NULL,NULL,'document','no membership')`);
			await q(
				`INSERT INTO agent_messages (id,user_id,thread_id,role,sequence,ui_message) VALUES ('msg1','u1','t1','user',0,'{}'),('msg5','u3','t5','user',0,'{}')`,
			);
			await q(
				`INSERT INTO agent_attachments (id,user_id,thread_id,message_id,storage_key,filename,media_type,size) VALUES ('at1','u1','t1','msg1','k','f','text/plain',1)`,
			);
			await q(
				`INSERT INTO agent_actions (id,user_id,thread_id,message_id,resume_id,kind,title,operations,base_updated_at,applied_updated_at)
				 VALUES ('ac1','u1','t1','msg1','r1','resume_patch','t','[]',now(),now())`,
			);
			await q(
				`INSERT INTO career_schedule (id,organization_id,user_id,kind,next_run_at,ai_provider_id) VALUES ('s1','o-old','u1','discovery',now(),'p1'),('s2','o-new','u1','discovery',now(),'p1')`,
			);
			await q(
				`INSERT INTO ai_content_report (id,user_id,source,reason,content,note) VALUES ('rep1','u1','other','other','c','n'),('rep3','u3','other','other','c','n')`,
			);

			const migration = await readFile(path.join(migrationsFolder, FOLDER, "migration.sql"), "utf8");
			const down = await readFile(path.join(migrationsFolder, FOLDER, "down.sql"), "utf8");
			const snapshot = async () => ({
				organizations: await q(`SELECT id,name,slug,metadata FROM organization ORDER BY id`),
				members: await q(`SELECT id,organization_id,user_id,role FROM member ORDER BY id`),
				rows: await q(
					TABLES.map((t) => `SELECT '${t}' AS t, id, organization_id, user_id FROM ${t}`).join(" UNION ALL ") +
						" ORDER BY 1,2",
				),
				links: await q(`SELECT id, ai_provider_id, working_resume_id, application_id FROM agent_threads ORDER BY id`),
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

			// u3 (a connection, no membership) got a personal organization; u4 (nothing) did not. T04's rule for ids.
			const personal = `bf_${md5Of("u3")}`;
			expect(first.organizations.filter((o) => o.metadata === '{"careeros_backfill":true}').map((o) => o.id)).toEqual([
				personal,
			]);
			expect(first.members.filter((m) => m.user_id === "u4")).toEqual([]);

			// A conversation takes its application's, working resume's or owner's oldest organization; its children take
			// the conversation's; everything else takes the owner's oldest membership.
			const orgOf = (table: string, id: string) =>
				first.rows.find((row) => row.t === table && row.id === id)?.organization_id;
			const expectedOrgs: [string, string, string][] = [
				["ai_providers", "p1", "o-old"],
				["ai_providers", "p2", "o-2"],
				["ai_providers", "p3", personal],
				["ai_providers", "server-ai:o-old:u1", "o-old"],
				["agent_threads", "t1", "o-new"],
				["agent_threads", "t2", "o-old"],
				["agent_threads", "t3", "o-2"],
				["agent_threads", "t4", "o-new"],
				["agent_threads", "t5", personal],
				["agent_messages", "msg1", "o-new"],
				["agent_messages", "msg5", personal],
				["agent_attachments", "at1", "o-new"],
				["agent_actions", "ac1", "o-new"],
				["ai_content_report", "rep1", "o-old"],
				["ai_content_report", "rep3", personal],
			];
			for (const [table, id, org] of expectedOrgs) expect(orgOf(table, id), `${table} ${id}`).toBe(org);
			// Nothing else changed: the same rows in every table.
			expect(await countAll()).toEqual(before);
			// The server connection was renamed per organization and its link followed; a connection in another
			// organization than its conversation was cleared (t1 keeps its document); a schedule's likewise.
			expect(first.links).toEqual([
				{ id: "t1", ai_provider_id: null, working_resume_id: "r1", application_id: null },
				{ id: "t2", ai_provider_id: "server-ai:o-old:u1", working_resume_id: null, application_id: null },
				{ id: "t3", ai_provider_id: "p2", working_resume_id: null, application_id: null },
				{ id: "t4", ai_provider_id: null, working_resume_id: null, application_id: "a1" },
				{ id: "t5", ai_provider_id: "p3", working_resume_id: null, application_id: null },
			]);
			expect(await q(`SELECT id, ai_provider_id FROM career_schedule ORDER BY id`)).toEqual([
				{ id: "s1", ai_provider_id: "p1" },
				{ id: "s2", ai_provider_id: null },
			]);

			// RLS is enabled and forced with both policies on all six tables, the column is NOT NULL, and the definer
			// functions exist.
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
			const functions = ["careeros_move_guest_agent", "careeros_orgs_with_active_agent_runs"];
			expect(
				await q(`SELECT proname, prosecdef FROM pg_proc WHERE proname = ANY($1) ORDER BY proname`, [functions]),
			).toEqual(functions.toSorted().map((proname) => ({ proname, prosecdef: true })));

			// D11: the default connection is one per (organization, user), not one per user.
			const defaultIndex = await q<{ indexdef: string }>(
				`SELECT indexdef FROM pg_indexes WHERE indexname = 'ai_providers_organization_id_user_id_index'`,
			);
			expect(defaultIndex[0]?.indexdef).toContain("(organization_id, user_id) WHERE is_default");
			expect(await q(`SELECT indexname FROM pg_indexes WHERE indexname = 'ai_providers_user_id_index'`)).toEqual([]);
			await q(
				`INSERT INTO ai_providers (id,organization_id,user_id,label,provider,model,${KEY},is_default) VALUES ('p4','o-new','u1','P','openai','m','e','s','h','p',true)`,
			);
			await expect(
				q(
					`INSERT INTO ai_providers (id,organization_id,user_id,label,provider,model,${KEY},is_default) VALUES ('p5','o-old','u1','P','openai','m','e','s','h','p',true)`,
				),
			).rejects.toMatchObject({ code: "23505" });

			// The composite keys refuse a link into another organization, for every writer, and clear only the id on delete.
			await expect(
				q(
					`INSERT INTO agent_threads (id,organization_id,user_id,working_resume_id,title) VALUES ('x1','o-old','u1','r1','x')`,
				),
			).rejects.toMatchObject({ code: "23503" });
			await expect(
				q(
					`INSERT INTO agent_threads (id,organization_id,user_id,ai_provider_id,title) VALUES ('x2','o-new','u1','p1','x')`,
				),
			).rejects.toMatchObject({ code: "23503" });
			await expect(q(`UPDATE career_schedule SET ai_provider_id = 'p2' WHERE id = 's1'`)).rejects.toMatchObject({
				code: "23503",
			});
			await expect(
				q(
					`INSERT INTO agent_messages (id,organization_id,user_id,thread_id,role,sequence,ui_message) VALUES ('x3','o-old','u1','t1','user',9,'{}')`,
				),
			).rejects.toMatchObject({ code: "23503" });
			await q(`DELETE FROM resume WHERE id = 'r1'`);
			expect(await q(`SELECT organization_id, working_resume_id FROM agent_threads WHERE id = 't1'`)).toEqual([
				{ organization_id: "o-new", working_resume_id: null },
			]);
			expect(await q(`SELECT organization_id, resume_id FROM agent_actions WHERE id = 'ac1'`)).toEqual([
				{ organization_id: "o-new", resume_id: null },
			]);
			await q(`DELETE FROM application WHERE id = 'a1'`);
			expect(await q(`SELECT id FROM agent_threads WHERE id = 't4'`)).toEqual([]);

			// A second run changes nothing it already did (the rows added above stay as they are).
			const second = await snapshot();
			await q(migration);
			expect(await snapshot()).toEqual(second);

			// Down refuses while a user has rows in two organizations, and then changes nothing.
			await expect(q(down)).rejects.toMatchObject({ message: expect.stringContaining("more than one organization") });
			expect(await snapshot()).toEqual(second);
			for (const table of ["career_schedule", ...[...TABLES].reverse()])
				await q(`DELETE FROM ${table} WHERE organization_id = 'o-new'`);
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
			expect(await q(`SELECT id FROM ai_providers WHERE user_id = 'u1' ORDER BY id`)).toEqual([
				{ id: "p1" },
				{ id: "server-ai:u1" },
			]);
			expect(await q(`SELECT ai_provider_id FROM agent_threads WHERE id = 't2'`)).toEqual([
				{ ai_provider_id: "server-ai:u1" },
			]);
			expect(await q(`SELECT indexname FROM pg_indexes WHERE indexname = 'ai_providers_user_id_index'`)).toEqual([
				{ indexname: "ai_providers_user_id_index" },
			]);
			expect(
				await q(
					`SELECT conname FROM pg_constraint WHERE conname ~ '_org_[a-z_]+_fkey$' AND conname !~ '_organization_id_' AND conrelid::regclass::text = ANY($1)`,
					[[...TABLES, "career_schedule"]],
				),
			).toEqual([]);
			expect(await q(`SELECT conname FROM pg_constraint WHERE conname = 'resume_organization_id_id_unique'`)).toEqual(
				[],
			);

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
