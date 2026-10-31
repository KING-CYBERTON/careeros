// Creates the `careeros_owner` and `careeros_app` roles over the superuser connection (CAREEROS_TEST_DATABASE_URL)
// by running the shared bootstrap SQL (infra/db/bootstrap-roles.sql, the single source of truth, P1-C01).
// CAREEROS_TEST_APP_ROLE_PASSWORD / CAREEROS_TEST_OWNER_ROLE_PASSWORD set the passwords; the defaults are
// disposable CI/local fixture values.
import { readFile } from "node:fs/promises";
import pg from "pg";

const ownerUrl = process.env.CAREEROS_TEST_DATABASE_URL;
if (!ownerUrl) {
	console.error("CAREEROS_TEST_DATABASE_URL is required (owner/superuser connection).");
	process.exit(1);
}

// Disposable fixture value, matching the CI workflow's CAREEROS_TEST_APP_DATABASE_URL. Not a secret.
const appPassword = process.env.CAREEROS_TEST_APP_ROLE_PASSWORD ?? "careeros_app";
const ownerPassword = process.env.CAREEROS_TEST_OWNER_ROLE_PASSWORD ?? "careeros_owner";
const sql = await readFile(new URL("../../../infra/db/bootstrap-roles.sql", import.meta.url), "utf8");

const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
try {
	await client.query("SELECT set_config('careeros.app_password', $1, false)", [appPassword]);
	await client.query("SELECT set_config('careeros.owner_password', $1, false)", [ownerPassword]);
	await client.query(sql);
	console.log("careeros_owner and careeros_app roles are ready.");
} finally {
	await client.end();
}
