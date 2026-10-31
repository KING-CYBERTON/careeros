import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as tables from "@reactive-resume/db/schema";
import { deleteAllUsers } from "./delete-users";

const databaseUrl = process.env.INTEGRATIONS_TEST_DATABASE_URL ?? process.env.COVER_LETTER_TEST_DATABASE_URL;
const USERNAME_COUNT = 50;
const ROUNDS = 20;

// Real PostgreSQL, opt-in only. Two schemas hold the same usernames; advisory locks are database-wide, so concurrent
// cleanups contend exactly as concurrent test files do.
describe.skipIf(!databaseUrl)("deleteAllUsers: concurrent cleanup", () => {
	let admin: Pool;
	const pools: Pool[] = [];
	const schemas = [0, 1].map((n) => `delete_users_test_${n}_${randomUUID().replaceAll("-", "")}`);
	const usernames = Array.from({ length: USERNAME_COUNT }, (_, i) => `race-user-${String(i).padStart(3, "0")}`);

	beforeAll(async () => {
		admin = new Pool({ connectionString: databaseUrl });
		const migrations = new URL("../../../../migrations/", import.meta.url);
		const directories = (await readdir(migrations, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
			.map((entry) => entry.name)
			.sort();
		for (const schema of schemas) {
			await admin.query(`CREATE SCHEMA ${schema}`);
			const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
			pools.push(pool);
			for (const directory of directories) {
				const file = new URL(`${directory}/migration.sql`, migrations);
				if (!existsSync(file)) continue;
				await pool.query((await readFile(file, "utf8")).replaceAll('"public".', ""));
			}
		}
	}, 60_000);

	afterAll(async () => {
		await Promise.all(pools.map((pool) => pool.end()));
		for (const schema of schemas) await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
		await admin?.end();
	});

	// Opposite insertion orders give the two schemas opposite physical row orders.
	async function seed(pool: Pool, reverse: boolean) {
		const names = reverse ? [...usernames].reverse() : usernames;
		for (const name of names) {
			await pool.query(`INSERT INTO "user" (id,name,email,username,display_username) VALUES ($1,$2,$3,$4,$4)`, [
				`${name}-${randomUUID()}`,
				name,
				`${name}@example.test`,
				name,
			]);
		}
	}

	it("never fails when two connections delete the same usernames at the same time", async () => {
		const dbs = pools.map((pool) => drizzle({ client: pool }));
		for (let round = 0; round < ROUNDS; round++) {
			await Promise.all(pools.map((pool, index) => seed(pool, index === 1)));
			await expect(Promise.all(dbs.map((db) => deleteAllUsers(db, tables.user)))).resolves.toBeDefined();
			for (const pool of pools) {
				expect((await pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n).toBe(0);
				// Deleting users reserves their usernames for 30 days; clear that so the next round can re-seed them.
				await pool.query("DELETE FROM released_username");
			}
		}
	}, 120_000);
});
