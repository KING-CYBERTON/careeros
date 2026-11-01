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
	const migration = await readFile(
		new URL("../../../migrations/20261101004553_resumes_rls/migration.sql", import.meta.url),
		"utf8",
	);
	const match = /CREATE OR REPLACE FUNCTION public\.careeros_move_guest_resumes[\s\S]*?\n\$\$;/.exec(migration);
	if (!match) throw new Error("The guest-link function was not found in the migration.");
	const ddl = match[0]
		.replaceAll("SET search_path = pg_catalog, public", `SET search_path = pg_catalog, ${schemaName}`)
		.replaceAll("public.", `${schemaName}.`);
	await client.query(ddl);
}

/** Makes `guestId` a guest account and `targetId` a member of the test organization, so a guest link can move work. */
export async function prepareGuestLink(client: Pick<Pool, "query">, guestId: string, targetId: string): Promise<void> {
	await client.query(`UPDATE "user" SET is_anonymous = true WHERE id = $1`, [guestId]);
	await client.query(
		`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner') ON CONFLICT DO NOTHING`,
		[`member-${targetId}`, TEST_ORGANIZATION_ID, targetId],
	);
}
