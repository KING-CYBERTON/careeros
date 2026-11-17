import type { E2EAccount } from "./data";
import { Pool } from "pg";
import { withSeedPool } from "./seed-db";

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

// CareerOS (P3-T02): a new organization starts on the one-seat personal plan, so specs that invite people or use paid
// features move it to a plan first. Plan and status are written through the platform's definer function, as the
// application cannot change them.

/** Sets an organization's plan and/or status (null leaves a value as it is). */
export async function setOrganizationPlan(organizationId: string, planId: string | null, status: string | null = null) {
	await withSeedPool((pool) =>
		pool.query("select careeros_set_org_plan($1, $2, $3, null, $4)", [organizationId, planId, status, "e2e"]),
	);
}

/** The id of the organization an account belongs to (its personal workspace right after sign-up). */
export async function accountOrganizationId(account: E2EAccount): Promise<string> {
	return await withSeedPool(async (pool) => {
		const result = await pool.query<{ id: string }>(
			`select m.organization_id as id from member m join "user" u on u.id = m.user_id
			 where u.email = $1 order by m.created_at limit 1`,
			[account.email],
		);
		const id = result.rows[0]?.id;
		if (!id) throw new Error(`${account.email} has no organization`);
		return id;
	});
}

export async function setAccountOrganizationPlan(
	account: E2EAccount,
	planId: string | null,
	status: string | null = null,
) {
	await setOrganizationPlan(await accountOrganizationId(account), planId, status);
}

/** Changes a plan's seat limit (null = unlimited) and returns the previous value so the caller can restore it. */
export async function setPlanSeatLimit(planId: string, seatLimit: number | null): Promise<number | null> {
	return await withSeedPool(async (pool) => {
		const previous = await pool.query<{ seat_limit: number | null }>("select seat_limit from plan where id = $1", [
			planId,
		]);
		await pool.query("update plan set seat_limit = $2 where id = $1", [planId, seatLimit]);
		return previous.rows[0]?.seat_limit ?? null;
	});
}
