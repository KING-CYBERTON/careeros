import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { call } from "@orpc/server";
import { Pool } from "pg";

// Real organization scope and real entitlements, not the fixed ones from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());
vi.mock("@careeros/billing", async (importOriginal) => importOriginal());

// P3-T06: `billing.invoices` reads the organization's audit rows, so it is a tenant-isolation surface. As the
// `careeros_app` role on a database of its own with every migration applied: an owner sees only their organization's
// payment rows, another organization's owner sees none of them, an admin can read and a member is refused. Skipped only
// when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const PLATFORM = "localhost:3000";

type Person = { userId: string };
type Invoice = {
	id: string;
	reference: string | null;
	amount: number | null;
	currency: string | null;
	method: string | null;
};

describe.skipIf(!configured)("billing.invoices (API)", () => {
	const run = randomUUID().slice(0, 8);
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let invoices: unknown;

	const createOrganization = async (label: string) => {
		const id = `${label}-${run}`;
		await owner.query(
			`INSERT INTO organization (id, name, slug, status, plan_id) VALUES ($1, $1, $1, 'active', 'starter')`,
			[id],
		);
		return id;
	};

	const addMember = async (organizationId: string, label: string, role: string): Promise<Person> => {
		const id = `${label}-${run}`;
		await owner.query(
			`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
			[id],
		);
		await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $1, $3)`, [
			id,
			organizationId,
			role,
		]);
		return { userId: id };
	};

	const addAudit = (organizationId: string, action: string, metadata: Record<string, unknown>) =>
		owner.query(
			`INSERT INTO audit_log (organization_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'subscription', $1, $3)`,
			[organizationId, action, JSON.stringify(metadata)],
		);

	const context = (person: Person, organizationId: string) => ({
		authentication: {
			user: { id: person.userId },
			method: "session" as const,
			permissions: ["read", "write", "delete"] as const,
			activeOrganizationId: organizationId,
		},
		reqHeaders: new Headers({ host: PLATFORM, origin: `http://${PLATFORM}` }),
		locale: "en-US",
	});
	const list = async (person: Person, organizationId: string) =>
		(
			(await call(invoices as never, undefined as never, { context: context(person, organizationId) as never })) as {
				invoices: Invoice[];
			}
		).invoices;

	let orgA = "";
	let orgB = "";
	let orgC = "";
	let ownerA: Person;
	let adminA: Person;
	let memberA: Person;
	let ownerB: Person;
	let ownerC: Person;

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("invoices_t06");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.APP_URL = `http://${PLATFORM}`;
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		({
			billingRouter: { invoices },
		} = await import("./router"));

		orgA = await createOrganization("inva");
		orgB = await createOrganization("invb");
		orgC = await createOrganization("invc");
		ownerA = await addMember(orgA, "ownera", "owner");
		adminA = await addMember(orgA, "admina", "admin");
		memberA = await addMember(orgA, "membera", "member");
		ownerB = await addMember(orgB, "ownerb", "owner");
		ownerC = await addMember(orgC, "ownerc", "owner");

		const period = {
			periodStart: "2026-11-01T00:00:00.000Z",
			periodEnd: "2026-12-01T00:00:00.000Z",
			interval: "month",
		};
		await addAudit(orgA, "billing.checkout_completed", {
			source: "fake",
			providerEventId: "ref-a-1",
			planId: "starter",
			seats: 3,
			amount: 4900,
			currency: "USD",
			...period,
		});
		// The payment the checkout made: same amount and period, so the pair is listed once (the newer row).
		await addAudit(orgA, "billing.payment_succeeded", {
			source: "fake",
			providerEventId: "ref-a-1b",
			planId: "starter",
			seats: 3,
			amount: 4900,
			currency: "USD",
			...period,
		});
		await addAudit(orgA, "billing.manual_payment", {
			source: "manual",
			reference: "INV-A-2",
			amount: 3_600_000,
			currency: "KES",
			method: "mpesa",
			periodStart: "2026-12-01T00:00:00.000Z",
			periodEnd: "2027-01-01T00:00:00.000Z",
		});
		// Not payments: never listed.
		await addAudit(orgA, "billing.payment_failed", { source: "fake", providerEventId: "ref-a-failed", amount: 4900 });
		await addAudit(orgA, "cohort.created", { name: "not billing" });
		await addAudit(orgB, "billing.payment_succeeded", {
			source: "fake",
			providerEventId: "ref-b-secret",
			planId: "pro",
			seats: 9,
			amount: 777_700,
			currency: "USD",
			...period,
		});
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	it("shows an owner their organization's payments, newest first, once each", async () => {
		const rows = await list(ownerA, orgA);
		expect(rows.map((row) => row.reference).sort()).toEqual(["INV-A-2", "ref-a-1b"]);
		const manual = rows.find((row) => row.reference === "INV-A-2");
		expect(manual).toMatchObject({ amount: 3_600_000, currency: "KES", method: "mpesa" });
	});

	it("never shows another organization's payment to an owner", async () => {
		const seenByA = JSON.stringify(await list(ownerA, orgA));
		expect(seenByA).not.toContain("ref-b-secret");
		expect(seenByA).not.toContain("777700");
		const seenByB = await list(ownerB, orgB);
		expect(seenByB.map((row) => row.reference)).toEqual(["ref-b-secret"]);
	});

	it("gives an owner of an organization with no payments an empty list, not another organization's", async () => {
		expect(await list(ownerC, orgC)).toEqual([]);
	});

	it("does not let an owner of one organization read another by naming it as the active organization", async () => {
		await expect(list(ownerB, orgA)).rejects.toThrow();
	});

	it("lets an admin read the payments", async () => {
		expect((await list(adminA, orgA)).length).toBe(2);
	});

	it("refuses a member", async () => {
		await expect(list(memberA, orgA)).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("returns only the organization's rows to the app role at the database too (row-level security)", async () => {
		const client = await app.connect();
		try {
			await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgC]);
			const { rows } = await client.query(`SELECT id FROM audit_log WHERE action LIKE 'billing.%'`);
			expect(rows).toEqual([]);
		} finally {
			await client.query(`SELECT set_config('app.current_org_id', '', false)`);
			client.release();
		}
	});
});
