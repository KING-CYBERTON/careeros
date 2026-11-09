import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";
import { withDatabasePool } from "@reactive-resume/db/client";

// P6-T02: the Super Admin test send writes one platform audit row through `careeros_audit_platform` as the
// `careeros_app` role, under a name that is not `admin.*` (the function refuses those, Q422), and no address is in it.
// The provider is replaced: no real network. Skipped only when the CAREEROS_TEST_* variables are absent.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const sendTestEmail = vi.hoisted(() => vi.fn());
vi.mock("@reactive-resume/email/test-send", () => ({ sendTestEmail }));

describe.skipIf(!configured)("Super Admin test email audit", () => {
	const run = randomUUID().slice(0, 8);
	const actor = `mail-admin-${run}`;
	const adminAddress = `${actor}@example.test`;
	let owner: Pool;
	let app: Pool;
	let database: IsolatedTestDatabase;

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("email_test_t02");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		await owner.query(`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $2, $1, $1)`, [
			actor,
			adminAddress,
		]);
	}, 180_000);

	afterAll(async () => {
		await owner?.end();
		await app?.end();
		await database?.drop();
	});

	const auditRows = async () =>
		(
			await owner.query<{ organization_id: string | null; action: string; metadata: unknown }>(
				`SELECT organization_id, action, metadata FROM audit_log WHERE actor_user_id = $1 ORDER BY created_at`,
				[actor],
			)
		).rows;

	it("mails the address it is given and writes one platform row named email.test_sent without the address", async () => {
		sendTestEmail.mockResolvedValue({ provider: "plunk", outcome: "queued", emailId: "email_1" });
		const { sendTestEmailToAdmin } = await import("./email-test");
		const result = await withDatabasePool(app, () => sendTestEmailToAdmin(actor, adminAddress));
		expect(result).toEqual({ provider: "plunk", outcome: "queued" });
		expect(sendTestEmail).toHaveBeenCalledWith(adminAddress);
		const rows = await auditRows();
		expect(rows).toEqual([
			{ organization_id: null, action: "email.test_sent", metadata: { provider: "plunk", outcome: "queued" } },
		]);
		expect(JSON.stringify(rows)).not.toContain(adminAddress);
	});

	it("audits a refusal with its error code", async () => {
		sendTestEmail.mockResolvedValue({ provider: "plunk", outcome: "failed", code: "plan_limit", status: 402 });
		const { sendTestEmailToAdmin } = await import("./email-test");
		await withDatabasePool(app, () => sendTestEmailToAdmin(actor, adminAddress));
		const rows = await auditRows();
		expect(rows.at(-1)?.metadata).toEqual({ provider: "plunk", outcome: "failed", code: "plan_limit", status: 402 });
	});

	it("cannot be used to forge a console (admin.*) row", async () => {
		await expect(
			app.query(`SELECT careeros_audit_platform($1, NULL, 'admin.email.test_sent', 'user', $1, '{}'::jsonb, NULL)`, [
				actor,
			]),
		).rejects.toThrow(/may not write console/);
	});
});
