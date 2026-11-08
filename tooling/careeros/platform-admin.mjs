// CAREEROS (P3-T07, phase plan D6): grant or remove the platform admin role. This is a command run by a person with
// database owner access, never an HTTP endpoint: the console cannot promote anyone (the Better Auth admin endpoints are
// switched off). Every change writes a platform `admin.role_granted` or `admin.role_revoked` audit row in the same
// transaction, with the operator's label and no email address.
//
//   DATABASE_MIGRATION_URL=postgres://careeros_owner:...@host/db \
//     node tooling/careeros/platform-admin.mjs grant person@example.com --operator "Stephen"
//   node tooling/careeros/platform-admin.mjs revoke person@example.com --operator "Stephen"
//   node tooling/careeros/platform-admin.mjs list
//
// The connection is the owner's (DATABASE_MIGRATION_URL, else OWNER_DATABASE_URL), because only the owner can write the
// `user` table without an organization. A granted admin still has to turn on two-factor authentication before the console
// answers: the database functions refuse an admin without it.
import { pathToFileURL } from "node:url";

/** The roles after adding or removing `admin`. Roles are a comma separated list; other roles are kept as they are. */
export function nextRole(current, change) {
	const roles = String(current ?? "")
		.split(",")
		.map((role) => role.trim())
		.filter(Boolean);
	const without = roles.filter((role) => role !== "admin");
	if (change === "revoke") return without.length > 0 ? without.join(",") : "user";
	return [...without.filter((role) => role !== "user"), "admin"].join(",");
}

export function hasAdmin(role) {
	return String(role ?? "")
		.split(",")
		.map((value) => value.trim())
		.includes("admin");
}

/** `{ command, email, operator }` or an Error for anything not understood. */
export function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (command === "list") return { command };
	if (command !== "grant" && command !== "revoke")
		return new Error("Usage: platform-admin.mjs grant|revoke <email> --operator <name> | list");
	const email = rest.find((value) => !value.startsWith("--") && rest[rest.indexOf(value) - 1] !== "--operator");
	const at = rest.indexOf("--operator");
	const operator = at >= 0 ? rest[at + 1] : undefined;
	if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) return new Error("An email address is required.");
	if (!operator || operator.startsWith("--") || operator.trim().length < 2 || operator.length > 80)
		return new Error("--operator <name> is required: who is running this command.");
	return { command, email: email.toLowerCase(), operator: operator.trim() };
}

async function main(argv, env) {
	const args = parseArgs(argv);
	if (args instanceof Error) {
		console.error(args.message);
		return 2;
	}
	const url = env.DATABASE_MIGRATION_URL || env.OWNER_DATABASE_URL;
	if (!url) {
		console.error("Set DATABASE_MIGRATION_URL (the database owner connection).");
		return 2;
	}
	const { default: pg } = await import("pg");
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		if (args.command === "list") {
			const { rows } = await client.query(
				`SELECT id, name, role, two_factor_enabled AS two_factor FROM "user" WHERE role ~ '(^|,)\\s*admin\\s*(,|$)' ORDER BY created_at`,
			);
			for (const row of rows)
				console.log(`${row.id}\t${row.name}\t${row.role}\ttwo-factor ${row.two_factor ? "on" : "OFF"}`);
			console.log(`${rows.length} platform admin(s).`);
			return 0;
		}
		await client.query("BEGIN");
		const { rows } = await client.query(`SELECT id, role FROM "user" WHERE lower(email) = $1 FOR UPDATE`, [args.email]);
		const found = rows[0];
		if (!found) {
			await client.query("ROLLBACK");
			console.error("No account has that email address.");
			return 1;
		}
		const was = hasAdmin(found.role);
		const wants = args.command === "grant";
		if (was === wants) {
			await client.query("ROLLBACK");
			console.log(wants ? "That account is already a platform admin." : "That account is not a platform admin.");
			return 0;
		}
		const role = nextRole(found.role, args.command);
		await client.query(`UPDATE "user" SET role = $2, updated_at = now() WHERE id = $1`, [found.id, role]);
		await client.query(
			`INSERT INTO audit_log (organization_id, actor_user_id, action, target_type, target_id, metadata)
			 VALUES (NULL, NULL, $1, 'user', $2, $3::jsonb)`,
			[
				wants ? "admin.role_granted" : "admin.role_revoked",
				found.id,
				JSON.stringify({ operator: args.operator, role }),
			],
		);
		await client.query("COMMIT");
		console.log(
			wants
				? `Granted. The admin must turn on two-factor authentication before the console opens. User id: ${found.id}`
				: `Removed. User id: ${found.id}`,
		);
		return 0;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		await client.end();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main(process.argv.slice(2), process.env);
}
