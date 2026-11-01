import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { authOrganizationRelations } from "@reactive-resume/db/schema";
import { guardTestPool } from "./integration-test-pool";

const fixture = vi.hoisted(() => ({
	db: undefined as unknown,
	pool: undefined as Pool | undefined,
}));
vi.mock("@reactive-resume/db/client", () => ({
	get db() {
		return fixture.db;
	},
	getPool: () => fixture.pool,
}));

const migrationsFolder = fileURLToPath(new URL("../../../migrations", import.meta.url));

// Opt-in real PostgreSQL test. Needs CREATE DATABASE permission; owns and deletes one disposable database.
describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)("organization plugin persistence", () => {
	let admin: Pool;
	let pool: Pool;
	let closePool: (() => Promise<void>) | undefined;
	const databaseName = `org_test_${randomUUID().replaceAll("-", "")}`;
	let auth: typeof import("./config").auth;

	const signUp = async (label: string) => {
		const suffix = randomUUID().slice(0, 8);
		const email = `${label}-${suffix}@example.test`;
		const { headers, response } = await auth.api.signUpEmail({
			body: { name: label, email, password: "correct-horse-battery", username: `${label}-${suffix}` } as never,
			returnHeaders: true,
		});
		const cookie = headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		return { email, userId: response.user.id, headers: new Headers({ cookie }) };
	};

	beforeAll(async () => {
		const databaseUrl = process.env.COVER_LETTER_TEST_DATABASE_URL;
		if (!databaseUrl) throw new Error("COVER_LETTER_TEST_DATABASE_URL is required");
		admin = new Pool({ connectionString: databaseUrl });
		await admin.query(`CREATE DATABASE "${databaseName}"`);
		const url = new URL(databaseUrl);
		url.pathname = `/${databaseName}`;
		pool = new Pool({ connectionString: url.toString() });
		closePool = guardTestPool(pool).close;
		fixture.pool = pool;
		fixture.db = drizzle({ client: pool, relations: authOrganizationRelations });
		await migrate(fixture.db as Parameters<typeof migrate>[0], { migrationsFolder });
		({ auth } = await import("./config"));
	}, 120_000);

	afterAll(async () => {
		await closePool?.();
		await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
		await admin?.end();
	});

	it("makes the creator the owner of a new organization", async () => {
		const owner = await signUp("owner");
		const org = await auth.api.createOrganization({
			body: { name: "Acme", slug: `acme-${randomUUID().slice(0, 8)}` },
			headers: owner.headers,
		});
		const { rows } = await pool.query("SELECT role, user_id FROM member WHERE organization_id = $1", [org.id]);
		expect(rows).toEqual([{ role: "owner", user_id: owner.userId }]);
	});

	it("adds an invited user as a member with invitedBy after acceptance", async () => {
		const owner = await signUp("inviter");
		const guest = await signUp("guest");
		// Accepting an invitation requires a verified email, which is the plugin's default for this auth config.
		await pool.query('UPDATE "user" SET email_verified = true WHERE id = $1', [guest.userId]);
		const org = await auth.api.createOrganization({
			body: { name: "Beta", slug: `beta-${randomUUID().slice(0, 8)}` },
			headers: owner.headers,
		});
		const invitation = await auth.api.createInvitation({
			body: { email: guest.email, role: "member", organizationId: org.id },
			headers: owner.headers,
		});
		expect(invitation.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
		await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: guest.headers });
		const { rows } = await pool.query(
			"SELECT role, invited_by, cohort_id FROM member WHERE organization_id = $1 AND user_id = $2",
			[org.id, guest.userId],
		);
		expect(rows).toEqual([{ role: "member", invited_by: owner.userId, cohort_id: null }]);
	});

	it("stores the active organization on the session and refuses non-members", async () => {
		const owner = await signUp("active");
		const outsider = await signUp("outsider");
		const org = await auth.api.createOrganization({
			body: { name: "Gamma", slug: `gamma-${randomUUID().slice(0, 8)}` },
			headers: owner.headers,
		});

		await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: owner.headers });
		const owned = await pool.query("SELECT active_organization_id FROM session WHERE user_id = $1", [owner.userId]);
		expect(owned.rows.map((row) => row.active_organization_id)).toContain(org.id);

		await expect(
			auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: outsider.headers }),
		).rejects.toThrow();
		const rejected = await pool.query("SELECT active_organization_id FROM session WHERE user_id = $1", [
			outsider.userId,
		]);
		expect(rejected.rows.every((row) => row.active_organization_id === null)).toBe(true);
	});
});
