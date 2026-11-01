// CAREEROS (P1-T04): integration-test helper. Resume rows now need an organization (`organization_id` is NOT NULL with a
// foreign key). The shared test setup (`vitest.org.setup.ts`) puts every service call in this organization.
import type { Pool } from "pg";

export const TEST_ORGANIZATION_ID = "org_test";

/** Creates the fixed test organization (idempotent). Pass the owner/superuser pool or any `{ query }` client. */
export async function ensureTestOrganization(client: Pick<Pool, "query">): Promise<void> {
	await client.query(
		`INSERT INTO organization (id, name, slug) VALUES ($1, 'Test organization', 'org-test') ON CONFLICT (id) DO NOTHING`,
		[TEST_ORGANIZATION_ID],
	);
}

/**
 * Tests that build their own schema (`CREATE TABLE ... LIKE public.x`, or the migrations replayed into it) need the
 * guest-link function for that schema: the migration's copy works on the `public` tables. This installs one that works
 * on `schemaName`, taken from the migration itself so the two cannot drift.
 */
export async function installSchemaLocalGuestMove(client: Pick<Pool, "query">, schemaName: string): Promise<void> {
	const { readFile } = await import("node:fs/promises");
	// CAREEROS (P1-T05): the cover letter function lives in its own migration.
	const sources = [
		["20261101004553_resumes_rls", "careeros_move_guest_resumes"],
		["20261101072723_cover_letters_rls", "careeros_move_guest_cover_letters"],
		// CAREEROS (P1-T06): applications, lanes, the pipeline and the profile
		["20261101080505_applications_rls", "careeros_move_guest_applications"],
		// CAREEROS (P1-T07): saved answers and the career rows that follow the guest's applications
		["20261101083119_career_rls", "careeros_move_guest_career"],
		// CAREEROS (P1-T07): the career scheduler's organization and job lists
		["20261101083119_career_rls", "careeros_due_career_jobs"],
		["20261101083119_career_rls", "careeros_orgs_with_due_career_schedules"],
		["20261101083119_career_rls", "careeros_orgs_with_career_upkeep"],
		// CAREEROS (P1-T08): saved AI connections, assistant conversations and content reports
		["20261101085357_agent_ai_rls", "careeros_move_guest_agent"],
		// CAREEROS (P1-T09): the remaining tables' functions, including the account-delete trigger function, whose
		// schema-local copy would otherwise stay the pre-T09 one (the migration replaces only the public copy).
		["20261101083301_remaining_rls", "careeros_public_domain_owner", "custom_domain"],
		["20261101083301_remaining_rls", "careeros_verified_domains", "custom_domain"],
		["20261101083301_remaining_rls", "careeros_public_verified_domain", "custom_domain"],
		["20261101083301_remaining_rls", "careeros_release_domain_claims", "custom_domain"],
		["20261101083301_remaining_rls", "careeros_stale_custom_domains", "custom_domain"],
		["20261101083301_remaining_rls", "careeros_due_storage_cleanup", "storage_cleanup_job"],
		// CAREEROS (P1-Q09): the database-clock overload the storage cleanup worker calls
		["20261101142451_storage_cleanup_db_time", "careeros_due_storage_cleanup", "storage_cleanup_job"],
		["20261101083301_remaining_rls", "careeros_guest_cleanup_prefixes", "storage_cleanup_job"],
		["20261101083301_remaining_rls", "enqueue_account_storage_cleanup", "storage_cleanup_job"],
	] as const satisfies readonly (readonly [string, string, string?])[];
	for (const [folder, name, requiredTable] of sources) {
		// A test that builds only some tables gets only the functions that work on them.
		if (requiredTable) {
			const { rows } = await client.query(`SELECT to_regclass($1) AS found`, [`${schemaName}.${requiredTable}`]);
			if (!rows[0]?.found) continue;
		}
		const migration = await readFile(new URL(`../../../migrations/${folder}/migration.sql`, import.meta.url), "utf8");
		const match = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\n\\$\\$;`).exec(migration);
		if (!match) throw new Error(`The guest-link function ${name} was not found in the migration.`);
		const ddl = match[0]
			.replaceAll("SET search_path = pg_catalog, public", `SET search_path = pg_catalog, ${schemaName}`)
			.replaceAll("public.", `${schemaName}.`);
		await client.query(ddl);
	}
}

/** Makes `guestId` a guest account and `targetId` a member of the test organization, so a guest link can move work. */
export async function prepareGuestLink(client: Pick<Pool, "query">, guestId: string, targetId: string): Promise<void> {
	await client.query(`UPDATE "user" SET is_anonymous = true WHERE id = $1`, [guestId]);
	await client.query(
		`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner') ON CONFLICT DO NOTHING`,
		[`member-${targetId}`, TEST_ORGANIZATION_ID, targetId],
	);
}
