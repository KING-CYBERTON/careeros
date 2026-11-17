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

// CAREEROS (P1-T06): the application tenant migration on a database that already holds applications. Applies every
// migration before it (including P1-T04 and P1-T05), seeds applications, lanes, pipelines and profiles for users with
// one, two and no organization, runs the migration, runs it a second time, checks the new keys and the lane trigger,
// then runs the down migration (which must refuse while a user has rows in two organizations) and the migration again.
// Needs CREATE DATABASE permission; owns and deletes one disposable database, never the supplied one.
const migrationsFolder = fileURLToPath(new URL("../../../migrations", import.meta.url));
const md5Of = (value: string) => createHash("md5").update(value).digest("hex");
const FOLDER = "20261101080505_applications_rls";
const TABLES = ["application", "application_lane", "application_pipeline", "application_profile"];

describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("application tenancy migration", () => {
	it("backfills organization ids, changes the keys, is idempotent, enables forced RLS, and reverses", async () => {
		const databaseUrl = process.env.COVER_LETTER_TEST_DATABASE_URL;
		if (!databaseUrl) throw new Error("COVER_LETTER_TEST_DATABASE_URL is required");
		const admin = new Pool({ connectionString: databaseUrl });
		const baselineFolder = await mkdtemp(path.join(tmpdir(), "careeros-t06-migrations-"));
		const databaseName = `migration_t06_${randomUUID().replaceAll("-", "")}`;
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

			// Before: u1 belongs to two organizations (the older one wins), u2 to one, u3 to none but has an application,
			// u4 has nothing at all, u5 has only an application profile and no organization.
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
			// The old lane trigger seeds each user's pipeline and default lanes on the first application.
			await q(
				`INSERT INTO application (id,user_id,company,role) VALUES ('a1','u1','C1','R'),('a3','u2','C3','R'),('a4','u3','C4','R')`,
			);
			await q(
				`INSERT INTO application_lane (id,user_id,category,label,color,position) VALUES ('cl1','u1','interview','Technical','#123456',10)`,
			);
			await q(
				`INSERT INTO application (id,user_id,company,role,status,lane_id) VALUES ('a2','u1','C2','R','interview','cl1')`,
			);
			await q(
				`INSERT INTO application_profile (user_id,data,reviewed_at,revision) VALUES ('u1','{}',now(),'r1'),('u5','{}',now(),'r5')`,
			);
			await q(`UPDATE application_pipeline SET revision = 4 WHERE user_id = 'u1'`);

			const migration = await readFile(path.join(migrationsFolder, FOLDER, "migration.sql"), "utf8");
			const down = await readFile(path.join(migrationsFolder, FOLDER, "down.sql"), "utf8");
			const snapshot = async () => ({
				organizations: await q(`SELECT id,name,slug,metadata FROM organization ORDER BY id`),
				members: await q(`SELECT id,organization_id,user_id,role FROM member ORDER BY id`),
				rows: await q(`SELECT 'application' AS t,id,organization_id,user_id,lane_id AS extra FROM application UNION ALL
					SELECT 'lane',id,organization_id,user_id,system_key FROM application_lane UNION ALL
					SELECT 'pipeline',user_id,organization_id,user_id,revision::text FROM application_pipeline UNION ALL
					SELECT 'profile',user_id,organization_id,user_id,revision FROM application_profile ORDER BY 1,2,3`),
			});
			const before = {
				applications: await q(`SELECT id,user_id,company,status,lane_id FROM application ORDER BY id`),
				laneCount: (await q<{ n: number }>(`SELECT count(*)::int AS n FROM application_lane`))[0]?.n,
				profiles: await q(`SELECT user_id,data,revision FROM application_profile ORDER BY user_id`),
			};

			await q(migration);
			const first = await snapshot();

			// A user with application data and no organization got a personal one (u3 an application, u5 a profile); a
			// user without any (u4) did not. T04's rule for the name and ids.
			const backfilled = ["u3", "u5"].map((id) => `bf_${md5Of(id)}`);
			expect(first.organizations.filter((o) => o.metadata === '{"careeros_backfill":true}').map((o) => o.id)).toEqual(
				backfilled.toSorted(),
			);
			expect(first.members.filter((m) => m.user_id === "u4")).toEqual([]);
			expect(first.members.filter((m) => m.user_id === "u3")).toEqual([
				{ id: backfilled[0], organization_id: backfilled[0], user_id: "u3", role: "owner" },
			]);

			// Every row of a user takes the owner's oldest membership, so a lane is in the organization of its pipeline.
			const orgOf = (table: string, id: string) =>
				first.rows.find((row) => row.t === table && row.id === id)?.organization_id;
			expect(orgOf("application", "a1")).toBe("o-old");
			expect(orgOf("application", "a2")).toBe("o-old");
			expect(orgOf("application", "a3")).toBe("o-2");
			expect(orgOf("application", "a4")).toBe(backfilled[0]);
			expect(orgOf("lane", "cl1")).toBe("o-old");
			expect(orgOf("lane", "application-lane:u1:saved")).toBe("o-old");
			expect(orgOf("lane", "application-lane:u2:saved")).toBe("o-2");
			expect(orgOf("pipeline", "u1")).toBe("o-old");
			expect(orgOf("profile", "u1")).toBe("o-old");
			expect(orgOf("profile", "u5")).toBe(backfilled[1]);
			// Nothing else changed: the same applications, lane count, profile data and revisions.
			expect(await q(`SELECT id,user_id,company,status,lane_id FROM application ORDER BY id`)).toEqual(
				before.applications,
			);
			expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM application_lane`))[0]?.n).toBe(before.laneCount);
			expect(await q(`SELECT user_id,data,revision FROM application_profile ORDER BY user_id`)).toEqual(
				before.profiles,
			);
			expect(await q(`SELECT revision FROM application_pipeline WHERE user_id = 'u1'`)).toEqual([{ revision: 4 }]);

			// RLS is enabled and forced with both policies on all four tables, the column is NOT NULL, and the definer
			// functions exist (PUBLIC cannot execute them).
			const rls = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
				`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = 'r' ORDER BY relname`,
				[TABLES],
			);
			expect(rls).toHaveLength(4);
			for (const row of rls)
				expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
			const policies = await q<{ policyname: string; qual: string; with_check: string }>(
				`SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = ANY($1) ORDER BY tablename, policyname`,
				[TABLES],
			);
			expect(policies.map((p) => p.policyname)).toEqual(Array(4).fill(["owner_access", "tenant_isolation"]).flat());
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
				"careeros_move_guest_applications",
				"careeros_application_is_open",
				"careeros_application_org",
			];
			expect(
				await q(`SELECT proname, prosecdef FROM pg_proc WHERE proname = ANY($1) ORDER BY proname`, [functions]),
			).toEqual(functions.toSorted().map((proname) => ({ proname, prosecdef: true })));

			// D11: the keys are per (organization, user). A second organization can hold its own pipeline, profile and
			// lane of the same id, but not a second one in the same organization.
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
			expect(await keyColumns("application_pipeline", "p")).toEqual([
				{ name: "application_pipeline_pkey", columns: ["organization_id", "user_id"] },
			]);
			expect(await keyColumns("application_profile", "p")).toEqual([
				{ name: "application_profile_pkey", columns: ["organization_id", "user_id"] },
			]);
			expect(await keyColumns("application_lane", "p")).toEqual([
				{ name: "application_lane_pkey", columns: ["organization_id", "id"] },
			]);
			expect(await keyColumns("application_lane", "u")).toEqual([
				{ name: "application_lane_owner_id_unique", columns: ["organization_id", "user_id", "id"] },
				{ name: "application_lane_owner_system_unique", columns: ["organization_id", "user_id", "system_key"] },
			]);
			await q(`INSERT INTO application_pipeline (organization_id,user_id,revision) VALUES ('o-new','u1',9)`);
			await q(
				`INSERT INTO application_profile (organization_id,user_id,data,reviewed_at,revision) VALUES ('o-new','u1','{}',now(),'second')`,
			);
			await expect(
				q(`INSERT INTO application_pipeline (organization_id,user_id) VALUES ('o-old','u1')`),
			).rejects.toMatchObject({
				code: "23505",
			});
			// The lane trigger seeds the default lanes (same deterministic ids as in o-old) inside the application's own
			// organization, and the lane foreign key cannot cross organizations.
			await q(`INSERT INTO application (id,organization_id,user_id,company,role) VALUES ('a5','o-new','u1','C5','R')`);
			expect(
				await q(
					`SELECT organization_id, count(*)::int AS n FROM application_lane WHERE id LIKE 'application-lane:u1:%' GROUP BY 1 ORDER BY 1`,
				),
			).toEqual([
				{ organization_id: "o-new", n: 6 },
				{ organization_id: "o-old", n: 6 },
			]);
			expect(await q(`SELECT lane_id, status FROM application WHERE id = 'a5'`)).toEqual([
				{ lane_id: "application-lane:u1:saved", status: "saved" },
			]);
			await expect(
				q(
					`INSERT INTO application (id,organization_id,user_id,company,role,status,lane_id) VALUES ('a6','o-new','u1','C6','R','interview','cl1')`,
				),
			).rejects.toBeDefined();

			// A second run changes nothing it already did (the rows added above stay as they are).
			const second = await snapshot();
			await q(migration);
			expect(await snapshot()).toEqual(second);

			// Down refuses while a user has rows in two organizations, and then changes nothing.
			await expect(q(down)).rejects.toMatchObject({ code: "23505" });
			expect(await snapshot()).toEqual(second);
			await q(`DELETE FROM application WHERE id = 'a5'`);
			await q(`DELETE FROM application_lane WHERE organization_id = 'o-new'`);
			await q(`DELETE FROM application_pipeline WHERE organization_id = 'o-new'`);
			await q(`DELETE FROM application_profile WHERE organization_id = 'o-new'`);
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
			expect(await keyColumns("application_pipeline", "p")).toEqual([
				{ name: "application_pipeline_pkey", columns: ["user_id"] },
			]);
			expect(await keyColumns("application_profile", "p")).toEqual([
				{ name: "application_profile_pkey", columns: ["user_id"] },
			]);
			expect(await keyColumns("application_lane", "p")).toEqual([{ name: "application_lane_pkey", columns: ["id"] }]);
			expect(await keyColumns("application_lane", "u")).toEqual([
				{ name: "application_lane_owner_id_unique", columns: ["user_id", "id"] },
				{ name: "application_lane_owner_system_unique", columns: ["user_id", "system_key"] },
			]);
			expect(await q(`SELECT indexname FROM pg_indexes WHERE indexname LIKE 'application%organization_id%'`)).toEqual(
				[],
			);
			// The old lane trigger works again, and the data is intact.
			await q(`INSERT INTO application (id,user_id,company,role) VALUES ('a7','u4','C7','R')`);
			expect(await q(`SELECT lane_id FROM application WHERE id = 'a7'`)).toEqual([
				{ lane_id: "application-lane:u4:saved" },
			]);
			await q(`DELETE FROM application WHERE id = 'a7'`);
			await q(`DELETE FROM application_lane WHERE user_id = 'u4'`);
			await q(`DELETE FROM application_pipeline WHERE user_id = 'u4'`);
			expect(await q(`SELECT id,user_id,company,status,lane_id FROM application ORDER BY id`)).toEqual(
				before.applications,
			);

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
