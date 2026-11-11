import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { invoiceNumber, splitTax } from "@careeros/invoice";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { call } from "@orpc/server";
import { Pool } from "pg";

// Real organization scope and real entitlements, not the fixed ones from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());
vi.mock("@careeros/billing", async (importOriginal) => importOriginal());

// P3-T10 adds the invoice number, `billing.invoice`, `billing.invoicePdf` and the billing details (`billing.profile`,
// `billing.updateProfile`) to the same surface and the same database.
// P3-T06: `billing.invoices` reads the organization's audit rows, so it is a tenant-isolation surface. As the
// `careeros_app` role on a database of its own with every migration applied: an owner sees only their organization's
// payment rows, another organization's owner sees none of them, an admin can read and a member is refused. Skipped only
// when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const PLATFORM = "localhost:3000";

type Person = { userId: string };
type Invoice = {
	id: string;
	number: string;
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
	let invoice: unknown;
	let invoicePdf: unknown;
	let profile: unknown;
	let updateProfile: unknown;

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

	const run_ = async (procedure: unknown, input: unknown, person: Person, organizationId: string) =>
		call(procedure as never, input as never, { context: context(person, organizationId) as never }) as Promise<never>;

	let orgA = "";
	let orgB = "";
	let orgC = "";
	let orgD = "";
	let ownerD: Person;
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
		process.env.CAREEROS_INVOICE_VAT_RATE = "16";
		process.env.CAREEROS_INVOICE_PREFIX = "INV";
		process.env.CAREEROS_INVOICE_SELLER_NAME = "Example Careers Ltd";
		process.env.CAREEROS_INVOICE_SELLER_ADDRESS = "P.O. Box 00000|Nairobi, Kenya";
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		({
			billingRouter: { invoices, invoice, invoicePdf, profile, updateProfile },
		} = await import("./router"));

		orgA = await createOrganization("inva");
		orgB = await createOrganization("invb");
		orgC = await createOrganization("invc");
		ownerA = await addMember(orgA, "ownera", "owner");
		adminA = await addMember(orgA, "admina", "admin");
		memberA = await addMember(orgA, "membera", "member");
		ownerB = await addMember(orgB, "ownerb", "owner");
		ownerC = await addMember(orgC, "ownerc", "owner");
		orgD = await createOrganization("invd");
		ownerD = await addMember(orgD, "ownerd", "owner");

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
		await owner.query(
			`INSERT INTO audit_log (organization_id, action, target_type, target_id, metadata, created_at)
			 SELECT $1, 'billing.payment_succeeded', 'subscription', $1,
			   jsonb_build_object('source', 'fake', 'providerEventId', 'ev-' || g, 'planId', 'starter', 'seats', 2,
			     'amount', 1000 + g, 'currency', 'USD', 'interval', 'month',
			     'periodStart', '2026-01-01T00:00:00.000Z', 'periodEnd', '2026-02-01T00:00:00.000Z'),
			   now() - ((200 - g) * interval '1 minute')
			 FROM generate_series(1, 105) AS g`,
			[orgD],
		);
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

	// ---- P3-T10: invoice numbers, the invoice document, the PDF and the billing details

	it("numbers each payment by its position in the whole history, newest listed first", async () => {
		const rows = await list(ownerA, orgA);
		const manual = rows.find((row) => row.reference === "INV-A-2");
		const checkout = rows.find((row) => row.reference === "ref-a-1b");
		expect(manual?.number).toBe(invoiceNumber("INV", orgA, 2));
		expect(checkout?.number).toBe(invoiceNumber("INV", orgA, 1));
		expect(manual?.number).toMatch(/^INV-[A-Z2-7]{6}-0002$/);
	});

	it("keeps counting past the 100 listed: 105 payments list 100 rows numbered 0105 down to 0006", async () => {
		const rows = await list(ownerD, orgD);
		expect(rows).toHaveLength(100);
		expect(rows[0]?.number).toBe(invoiceNumber("INV", orgD, 105));
		expect(rows[99]?.number).toBe(invoiceNumber("INV", orgD, 6));
		expect(new Set(rows.map((row) => row.number)).size).toBe(100);
		// The oldest payment is past the list but is still invoice 1, and can be opened by its id.
		const { rows: oldest } = await owner.query<{ id: string }>(
			`SELECT id FROM audit_log WHERE organization_id = $1 ORDER BY created_at, id LIMIT 1`,
			[orgD],
		);
		const document = await run_(invoice, { id: oldest[0]?.id }, ownerD, orgD);
		expect((document as { number: string }).number).toBe(invoiceNumber("INV", orgD, 1));
	});

	it("builds the invoice for an owner and an admin: seller, customer name fallback, lines, VAT and totals", async () => {
		const id = (await list(ownerA, orgA)).find((row) => row.reference === "INV-A-2")?.id;
		for (const person of [ownerA, adminA]) {
			const document = (await run_(invoice, { id }, person, orgA)) as {
				number: string;
				status: string;
				currency: string;
				seller: { name: string; addressLines: string[]; logo: string };
				customer: { name: string; addressLines: string[] };
				payment: { method: string; reference: string };
				lines: { quantity: number; amount: number }[];
				subtotal: number;
				tax: { label: string; ratePercent: number; amount: number } | null;
				total: number;
				amountPaid: number;
				amountDue: number;
			};
			const { net, vat } = splitTax(3_600_000, 16);
			expect(document).toMatchObject({
				number: invoiceNumber("INV", orgA, 2),
				status: "paid",
				currency: "KES",
				seller: { name: "Example Careers Ltd", addressLines: ["P.O. Box 00000", "Nairobi, Kenya"], logo: "platform" },
				// No billing details yet: the organization's name.
				customer: { name: orgA, addressLines: [] },
				payment: { method: "mpesa", reference: "INV-A-2" },
				subtotal: net,
				tax: { label: "VAT", ratePercent: 16, amount: vat },
				total: 3_600_000,
				amountPaid: 3_600_000,
				amountDue: 0,
			});
			expect(document.subtotal + (document.tax?.amount ?? 0)).toBe(document.total);
			expect(document.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(net);
		}
	});

	it("refuses a member the invoice and the PDF, and answers NOT_FOUND for an unknown id", async () => {
		const id = (await list(ownerA, orgA))[0]?.id;
		await expect(run_(invoice, { id }, memberA, orgA)).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(run_(invoicePdf, { id }, memberA, orgA)).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(run_(invoice, { id: "does-not-exist" }, ownerA, orgA)).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("answers NOT_FOUND, not the document, for an invoice id of another organization", async () => {
		const idOfB = (await list(ownerB, orgB))[0]?.id;
		await expect(run_(invoice, { id: idOfB }, ownerA, orgA)).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(run_(invoicePdf, { id: idOfB }, ownerA, orgA)).rejects.toMatchObject({ code: "NOT_FOUND" });
		const idOfA = (await list(ownerA, orgA))[0]?.id;
		await expect(run_(invoice, { id: idOfA }, ownerB, orgB)).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("lets an owner and an admin read the billing details and refuses a member", async () => {
		for (const person of [ownerA, adminA])
			expect(await run_(profile, undefined, person, orgA)).toEqual({
				legalName: null,
				address: null,
				taxPin: null,
				billingEmail: null,
				updatedAt: null,
			});
		await expect(run_(profile, undefined, memberA, orgA)).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("lets only the owner change the billing details", async () => {
		const input = { legalName: "Acme Careers Ltd" };
		await expect(run_(updateProfile, input, adminA, orgA)).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(run_(updateProfile, input, memberA, orgA)).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await run_(profile, undefined, ownerA, orgA)).toMatchObject({ legalName: null });
	});

	it("trims the details, turns an empty string into null and records which fields changed, not their values", async () => {
		const saved = (await run_(
			updateProfile,
			{
				legalName: "  Acme Careers Ltd  ",
				address: " 1 Sample Road \r\n\n Nairobi ",
				taxPin: "P051234567Z",
				billingEmail: "accounts@acme.example.test",
			},
			ownerA,
			orgA,
		)) as Record<string, unknown>;
		expect(saved).toMatchObject({
			legalName: "Acme Careers Ltd",
			address: "1 Sample Road\nNairobi",
			taxPin: "P051234567Z",
			billingEmail: "accounts@acme.example.test",
		});
		expect(saved.updatedAt).toBeInstanceOf(Date);

		// Only what is sent changes; an empty string clears.
		const cleared = await run_(updateProfile, { taxPin: "   " }, ownerA, orgA);
		expect(cleared).toMatchObject({ legalName: "Acme Careers Ltd", taxPin: null });

		const { rows } = await owner.query<{ metadata: { fields: string[] } }>(
			`SELECT metadata FROM audit_log WHERE organization_id = $1 AND action = 'billing.profile_updated' ORDER BY created_at, id`,
			[orgA],
		);
		expect(rows.map((row) => row.metadata)).toEqual([
			{ fields: ["legalName", "address", "taxPin", "billingEmail"] },
			{ fields: ["taxPin"] },
		]);
		expect(JSON.stringify(rows)).not.toContain("Acme");
		expect(JSON.stringify(rows)).not.toContain("P051234567Z");
	});

	it("rejects billing details that are too long or not a single address", async () => {
		await expect(run_(updateProfile, { billingEmail: "not an address" }, ownerA, orgA)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(run_(updateProfile, { billingEmail: "Acme <a@example.test>" }, ownerA, orgA)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(run_(updateProfile, { legalName: "x".repeat(201) }, ownerA, orgA)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(run_(updateProfile, { taxPin: "P".repeat(33) }, ownerA, orgA)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(run_(updateProfile, { address: "x".repeat(501) }, ownerA, orgA)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(run_(updateProfile, { legalName: "Line\nbreak" }, ownerA, orgA)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("prints the saved details on the invoice, and never one organization's details on another's", async () => {
		const id = (await list(ownerA, orgA)).find((row) => row.reference === "INV-A-2")?.id;
		const document = (await run_(invoice, { id }, ownerA, orgA)) as {
			customer: { name: string; addressLines: string[]; taxPin: string | null; email: string | null };
		};
		expect(document.customer).toEqual({
			name: "Acme Careers Ltd",
			addressLines: ["1 Sample Road", "Nairobi"],
			taxPin: null,
			email: "accounts@acme.example.test",
		});
		const own = (await run_(profile, undefined, ownerB, orgB)) as { legalName: string | null };
		expect(own.legalName).toBeNull();
		const idOfB = (await list(ownerB, orgB))[0]?.id;
		const documentB = (await run_(invoice, { id: idOfB }, ownerB, orgB)) as { customer: { name: string } };
		expect(documentB.customer.name).toBe(orgB);
	});

	it("keeps the billing details of another organization out of reach at the database (row-level security)", async () => {
		const client = await app.connect();
		try {
			await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgC]);
			const { rows } = await client.query(`SELECT organization_id FROM organization_billing_profile`);
			expect(rows).toEqual([]);
			await expect(
				client.query(`INSERT INTO organization_billing_profile (organization_id, legal_name) VALUES ($1, 'x')`, [orgA]),
			).rejects.toThrow();
			await expect(client.query(`DELETE FROM organization_billing_profile`)).rejects.toThrow(/permission denied/);
		} finally {
			await client.query(`SELECT set_config('app.current_org_id', '', false)`);
			client.release();
		}
	});

	it("downloads the invoice as an attachment PDF for an owner and an admin", { timeout: 60_000 }, async () => {
		const row = (await list(ownerA, orgA)).find((entry) => entry.reference === "INV-A-2");
		for (const person of [ownerA, adminA]) {
			const response = (await run_(invoicePdf, { id: row?.id }, person, orgA)) as {
				headers: Record<string, string>;
				body: File;
			};
			expect(response.headers["content-disposition"]).toBe(`attachment; filename="${row?.number}.pdf"`);
			expect(response.body.type).toBe("application/pdf");
			const bytes = Buffer.from(await response.body.arrayBuffer());
			expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
		}
	});
});
