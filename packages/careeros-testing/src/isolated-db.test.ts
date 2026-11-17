import { describe, expect, it } from "vite-plus/test";
import pg from "pg";
import { createIsolatedTestDatabase } from "./isolated-db";

const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("createIsolatedTestDatabase (real Postgres)", () => {
	it("creates a migrated database the app role can use under RLS, apart from the shared one, and drops it", async () => {
		const [first, second] = await Promise.all([
			createIsolatedTestDatabase("iso_test"),
			createIsolatedTestDatabase("iso_test"),
		]);
		const owner = new pg.Pool({ connectionString: first.ownerUrl });
		const app = new pg.Pool({ connectionString: first.appUrl });
		const other = new pg.Pool({ connectionString: second.ownerUrl });
		try {
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ('u', 'u', 'u@example.test', 'u', 'u')`,
			);
			expect((await other.query(`SELECT count(*)::int AS n FROM "user"`)).rows[0].n).toBe(0);
			// No organization context: row-level security hides the row from the app role.
			expect((await app.query(`SELECT count(*)::int AS n FROM storage_cleanup_job`)).rows[0].n).toBe(0);
			expect((await app.query(`SELECT current_user AS u`)).rows[0].u).toBe("careeros_app");
			expect((await app.query(`SELECT count(*)::int AS n FROM careeros_due_storage_cleanup(now(), 1)`)).rows[0].n).toBe(
				0,
			);
		} finally {
			await Promise.all([owner.end(), app.end(), other.end()]);
			await Promise.all([first.drop(), second.drop()]);
		}
		const admin = new pg.Client({ connectionString: process.env.CAREEROS_TEST_DATABASE_URL });
		await admin.connect();
		try {
			const { rows } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = ANY($1)`, [
				[first.name, second.name],
			]);
			expect(rows).toHaveLength(0);
		} finally {
			await admin.end();
		}
	}, 120_000);
});
