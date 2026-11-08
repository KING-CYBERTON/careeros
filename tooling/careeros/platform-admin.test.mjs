import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hasAdmin, nextRole, parseArgs } from "./platform-admin.mjs";

// CAREEROS (P3-T07): the grant and revoke command. The pure rules always run; the database run needs the isolated test
// database (CAREEROS_TEST_DATABASE_URL, as for the integration suites) and is skipped without it.

test("nextRole adds and removes admin and keeps other roles", () => {
	assert.equal(nextRole("user", "grant"), "admin");
	assert.equal(nextRole(null, "grant"), "admin");
	assert.equal(nextRole("support", "grant"), "support,admin");
	assert.equal(nextRole("admin", "revoke"), "user");
	assert.equal(nextRole("support, admin", "revoke"), "support");
	assert.equal(nextRole("user", "revoke"), "user");
});

test("hasAdmin reads a comma separated list", () => {
	assert.equal(hasAdmin("admin"), true);
	assert.equal(hasAdmin("support, admin"), true);
	assert.equal(hasAdmin("administrator"), false);
	assert.equal(hasAdmin(null), false);
});

test("parseArgs needs a command, an email and an operator", () => {
	assert.deepEqual(parseArgs(["list"]), { command: "list" });
	assert.deepEqual(parseArgs(["grant", "A@Example.com", "--operator", "Stephen"]), {
		command: "grant",
		email: "a@example.com",
		operator: "Stephen",
	});
	assert.deepEqual(parseArgs(["revoke", "--operator", "Stephen", "a@example.com"]), {
		command: "revoke",
		email: "a@example.com",
		operator: "Stephen",
	});
	for (const bad of [
		[],
		["promote", "a@example.com"],
		["grant"],
		["grant", "not-an-email", "--operator", "Stephen"],
		["grant", "a@example.com"],
		["grant", "a@example.com", "--operator"],
	])
		assert.ok(parseArgs(bad) instanceof Error, JSON.stringify(bad));
});

const url = process.env.CAREEROS_TEST_DATABASE_URL;
const script = fileURLToPath(new URL("./platform-admin.mjs", import.meta.url));
const run = (...args) =>
	spawnSync(process.execPath, [script, ...args], {
		env: { ...process.env, DATABASE_MIGRATION_URL: url },
		encoding: "utf8",
	});

test("grant and revoke change the role and write one platform audit row each", { skip: !url }, async () => {
	const { default: pg } = await import("pg");
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	const id = `pa-tool-${randomUUID()}`;
	const email = `${id}@example.test`;
	try {
		await client.query(
			`INSERT INTO "user" (id, name, email, email_verified, username, display_username) VALUES ($1, 'Tool Test', $2, true, $1, $1)`,
			[id, email],
		);
		const grant = run("grant", email, "--operator", "Test Operator");
		assert.equal(grant.status, 0, grant.stderr);
		assert.equal((await client.query(`SELECT role FROM "user" WHERE id = $1`, [id])).rows[0].role, "admin");
		assert.equal(run("grant", email, "--operator", "Test Operator").status, 0);
		let audit = (
			await client.query(
				`SELECT action, organization_id, actor_user_id, metadata FROM audit_log WHERE target_id = $1 ORDER BY id`,
				[id],
			)
		).rows;
		assert.equal(audit.length, 1, "a repeat grant writes nothing");
		assert.equal(audit[0].action, "admin.role_granted");
		assert.equal(audit[0].organization_id, null);
		assert.deepEqual(audit[0].metadata, { operator: "Test Operator", role: "admin" });
		assert.equal(JSON.stringify(audit).includes("example.test"), false, "no email in the audit row");

		assert.equal(run("revoke", email, "--operator", "Test Operator").status, 0);
		assert.equal((await client.query(`SELECT role FROM "user" WHERE id = $1`, [id])).rows[0].role, "user");
		audit = (await client.query(`SELECT action FROM audit_log WHERE target_id = $1 ORDER BY created_at, id`, [id]))
			.rows;
		assert.deepEqual(audit.map((row) => row.action).sort(), ["admin.role_granted", "admin.role_revoked"]);
		assert.equal(run("grant", `missing-${id}@example.test`, "--operator", "Test Operator").status, 1);
	} finally {
		await client.query(`DELETE FROM "user" WHERE id = $1`, [id]);
		await client.end();
	}
});
