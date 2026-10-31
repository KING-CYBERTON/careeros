// Creates the `careeros_app` test role over the owner connection (CAREEROS_TEST_DATABASE_URL).
// CAREEROS_TEST_APP_ROLE_PASSWORD sets its password; the default is a disposable CI/local fixture value.
import { readFile } from "node:fs/promises";
import pg from "pg";

const ownerUrl = process.env.CAREEROS_TEST_DATABASE_URL;
if (!ownerUrl) {
	console.error("CAREEROS_TEST_DATABASE_URL is required (owner/superuser connection).");
	process.exit(1);
}

// Disposable fixture value, matching the CI workflow's CAREEROS_TEST_APP_DATABASE_URL. Not a secret.
const password = process.env.CAREEROS_TEST_APP_ROLE_PASSWORD ?? "careeros_app";
const sql = await readFile(new URL("../sql/create-app-role.sql", import.meta.url), "utf8");

const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
try {
	await client.query("SELECT set_config('careeros.app_password', $1, false)", [password]);
	await client.query(sql);
	console.log("careeros_app role is ready.");
} finally {
	await client.end();
}
