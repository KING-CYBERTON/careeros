// CAREEROS (P1-Q08): one throwaway database per integration test file. Files that share the `postgres` database race on
// global workers (storage cleanup, reapers, purges) and on objects that schema-local migration replays rewrite in
// `public`, so any file that runs such a worker or truncates tables gets its own database instead.
import type { CareerosTestEnv } from "./env";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { getTestEnv } from "./env";

export type IsolatedTestDatabase = {
	name: string;
	/** Owner (superuser) connection URL for setup and assertions. */
	ownerUrl: string;
	/** `careeros_app` connection URL: all reads under test go through it. */
	appUrl: string;
	/** Drops the database (terminating stragglers). Call after every pool opened on it has ended. */
	drop: () => Promise<void>;
};

const MIGRATIONS = new URL("../../../migrations/", import.meta.url);
const BOOTSTRAP = new URL("../../../infra/db/bootstrap-roles.sql", import.meta.url);
// Roles are cluster-wide: concurrent files must not run the bootstrap's ALTER ROLE at the same time.
const BOOTSTRAP_LOCK = 7_280_811;

function withDatabase(url: string, database: string): string {
	const parsed = new URL(url);
	parsed.pathname = `/${database}`;
	return parsed.toString();
}

export type IsolatedTestDatabaseOptions = {
	env?: CareerosTestEnv;
	/** Runs on the migrating connection right before and after each migration directory (data-upgrade fixtures). */
	onMigration?: (step: { directory: string; phase: "before" | "after" }, client: pg.Client) => Promise<void>;
};

/**
 * Creates a database, applies every shipped migration in order, then the shared role bootstrap (the same order CI
 * uses on `postgres`: migrate, then roles), and returns URLs for the owner and for `careeros_app`.
 */
export async function createIsolatedTestDatabase(
	prefix = "careeros_iso",
	options: IsolatedTestDatabaseOptions = {},
): Promise<IsolatedTestDatabase> {
	const env = options.env ?? getTestEnv();
	if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) throw new Error(`Invalid database prefix "${prefix}".`);
	const name = `${prefix}_${randomBytes(8).toString("hex")}`;
	const ownerUrl = withDatabase(env.ownerUrl, name);
	const appUrl = withDatabase(env.appUrl, name);
	const admin = new pg.Client({ connectionString: env.ownerUrl });
	admin.on("error", () => undefined);
	await admin.connect();
	const drop = async () => {
		// The caller has ended its pools, but the server may still be tearing the backends down (55006, object in
		// use). Wait for them to leave instead of forcing: FORCE would kill a client mid-`end()` and surface its 57P01 as
		// an uncaught error in the test process. Only a connection that never leaves is terminated.
		const deadline = Date.now() + 10_000;
		for (;;) {
			try {
				await admin.query(`DROP DATABASE IF EXISTS "${name}"${Date.now() > deadline ? " WITH (FORCE)" : ""}`);
				break;
			} catch (error) {
				if ((error as { code?: string }).code !== "55006") throw error;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		await admin.end();
	};
	try {
		await admin.query(`CREATE DATABASE "${name}"`);
		const directories = (await readdir(MIGRATIONS, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
			.map((entry) => entry.name)
			.sort();
		const client = new pg.Client({ connectionString: ownerUrl });
		await client.connect();
		try {
			for (const directory of directories) {
				const file = new URL(`${directory}/migration.sql`, MIGRATIONS);
				const sql = await readFile(file, "utf8").catch(() => null);
				if (!sql) continue;
				await options.onMigration?.({ directory, phase: "before" }, client);
				await client.query(sql);
				await options.onMigration?.({ directory, phase: "after" }, client);
			}
			const appPassword = new URL(env.appUrl).password || "careeros_app";
			const ownerPassword = process.env.CAREEROS_TEST_OWNER_ROLE_PASSWORD ?? "careeros_owner";
			await admin.query("SELECT pg_advisory_lock($1)", [BOOTSTRAP_LOCK]);
			try {
				await client.query("SELECT set_config('careeros.app_password', $1, false)", [appPassword]);
				await client.query("SELECT set_config('careeros.owner_password', $1, false)", [ownerPassword]);
				await client.query(await readFile(BOOTSTRAP, "utf8"));
			} finally {
				await admin.query("SELECT pg_advisory_unlock($1)", [BOOTSTRAP_LOCK]);
			}
		} finally {
			await client.end();
		}
	} catch (error) {
		await drop().catch(() => undefined);
		throw error;
	}
	return { name, ownerUrl, appUrl, drop };
}
