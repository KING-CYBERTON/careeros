import type { E2EAccount } from "./data";
import { Pool } from "pg";

// CareerOS (P1-T03): helpers for the organization specs. Kept apart from the upstream fixtures.

export function createInviteeAccount(owner: E2EAccount): E2EAccount {
	const username = `${owner.username}_b`.slice(0, 64);
	return { name: "Invitee User", username, email: `${username}@example.test`, password: owner.password };
}

async function withPool<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("DATABASE_URL is required for E2E setup and cleanup.");
	const pool = new Pool({ connectionString: databaseUrl });
	try {
		return await run(pool);
	} finally {
		await pool.end();
	}
}

/** Accepting an invitation needs a verified address; the e2e server sends no real email, so mark it directly. */
export async function markEmailVerified(account: E2EAccount) {
	await withPool((pool) => pool.query('update "user" set email_verified = true where email = $1', [account.email]));
}

/** Deletes the organizations whose members are all among these accounts (run before deleting the users). */
export async function deleteE2EOrganizations(accounts: E2EAccount[]) {
	const emails = accounts.map((account) => account.email);
	await withPool((pool) =>
		pool.query(
			`delete from organization o
			 where exists (
			   select 1 from member m join "user" u on u.id = m.user_id
			   where m.organization_id = o.id and u.email = any($1::text[]))
			 and not exists (
			   select 1 from member m join "user" u on u.id = m.user_id
			   where m.organization_id = o.id and not (u.email = any($1::text[])))`,
			[emails],
		),
	);
}
