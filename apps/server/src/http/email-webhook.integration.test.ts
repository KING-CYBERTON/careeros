import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";

// P6-T02: the Plunk event webhook and the suppression list end to end: the real Hono app and the `careeros_app` role on a
// database of its own with every migration applied. Plunk's HTTP API is a mocked fetch: no real network. Skipped only
// when the CAREEROS_TEST_* variables are absent.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

vi.unmock("@careeros/tenancy");

const SECRET = "integration-plunk-webhook-secret-0123456789";
const PLATFORM = "localhost:3000";
const hash = (address: string) => createHash("sha256").update(address.trim().toLowerCase()).digest("hex");

describe.skipIf(!configured)("Plunk webhook and the suppression list", () => {
	const run = randomUUID().slice(0, 8);
	const address = (label: string) => `${label}-${run}@Example.test`;
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let queries = 0;
	let hono: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

	const ownerRows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
		(await owner.query<T>(sql, params)).rows;
	const suppressedCount = async () =>
		Number((await ownerRows<{ n: string }>(`SELECT count(*)::text AS n FROM email_suppression`))[0]?.n);
	const isSuppressedByApp = async (value: string) =>
		(await app.query<{ s: boolean }>(`SELECT careeros_email_is_suppressed($1) AS s`, [hash(value)])).rows[0]?.s;

	const post = (
		payload: unknown,
		headers: Record<string, string> = { "x-careeros-webhook-secret": SECRET },
		host = PLATFORM,
	) =>
		Promise.resolve(
			hono.request(`http://${host}/api/email/webhook/plunk`, {
				method: "POST",
				headers: { host, "content-type": "application/json", ...headers },
				body: typeof payload === "string" ? payload : JSON.stringify(payload),
			}),
		);
	const event = (name: string, email: string, extra: Record<string, unknown> = {}) => ({
		event: name,
		contact: { email },
		email: { id: `email_${run}` },
		...extra,
	});

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("email_webhook_t02");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.APP_URL = `http://${PLATFORM}`;
		process.env.EMAIL_PROVIDER = "plunk";
		process.env.PLUNK_SECRET_KEY = "sk_integration_test_key";
		process.env.EMAIL_FROM_ADDRESS = "no-reply@example.test";
		process.env.PLUNK_WEBHOOK_SECRET = SECRET;
		process.env.ORG_HOST_PATTERN = "{slug}.orgs.test";
		process.env.TRUST_FORWARDED_HOST = "false";
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		const counting = new Proxy(app, {
			get(target, property) {
				const value = Reflect.get(target, property, target) as unknown;
				if (property === "query" || property === "connect")
					return (...args: unknown[]) => {
						queries += 1;
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as Pool;
		restorePool = client.bindGlobalPoolForTesting(counting);
		await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [`acme-${run}`]);
		const { createApp } = await import("./app");
		hono = createApp({ serveStatic: false, trustedClient: () => "203.0.113.9" });
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	it("refuses a missing or wrong secret with 401 and writes and reads nothing", async () => {
		const before = { rows: await suppressedCount(), queries };
		const payload = event("email.bounce", address("nosecret"), { bounceType: "Permanent" });
		for (const headers of [
			{},
			{ "x-careeros-webhook-secret": "" },
			{ "x-careeros-webhook-secret": "wrong-secret" },
			{ "x-careeros-webhook-secret": `${SECRET}x` },
			{ authorization: `Bearer ${SECRET}` },
		])
			expect((await post(payload, headers)).status).toBe(401);
		// Not even a body that is not JSON gets as far as being parsed.
		expect((await post("not json", {})).status).toBe(401);
		expect(await suppressedCount()).toBe(before.rows);
		expect(queries).toBe(before.queries);
		expect(await isSuppressedByApp(address("nosecret"))).toBe(false);
	});

	it("is not served on an organization host", async () => {
		const payload = event("email.bounce", address("orghost"), { bounceType: "Permanent" });
		expect((await post(payload, undefined, `acme-${run}.orgs.test`)).status).toBe(404);
		expect(await isSuppressedByApp(address("orghost"))).toBe(false);
	});

	it("suppresses a permanent bounce, stores only the hash, and matches the address in any case", async () => {
		const target = address("bounce");
		const response = await post(event("email.bounce", target, { bounceType: "Permanent" }));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ received: true, outcome: "suppressed" });
		const rows = await ownerRows<Record<string, string>>(`SELECT * FROM email_suppression WHERE email_hash = $1`, [
			hash(target),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ reason: "bounce", provider_email_id: `email_${run}` });
		expect(JSON.stringify(rows).toLowerCase()).not.toContain(`bounce-${run}`);
		expect(await isSuppressedByApp(target)).toBe(true);
		expect(await isSuppressedByApp(target.toUpperCase())).toBe(true);
		expect(await isSuppressedByApp(address("someone-else"))).toBe(false);
	});

	it("does not suppress a transient bounce, a delivery or an unknown event", async () => {
		const before = await suppressedCount();
		for (const payload of [
			event("email.bounce", address("transient"), { bounceType: "Transient" }),
			event("email.bounce", address("transient"), {}),
			event("email.delivery", address("delivered")),
			event("email.open", address("opened")),
		]) {
			const response = await post(payload);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ received: true, outcome: "ignored" });
		}
		expect(await suppressedCount()).toBe(before);
		expect(await isSuppressedByApp(address("transient"))).toBe(false);
	});

	it("suppresses a complaint, and a repeated event changes nothing", async () => {
		const target = address("complaint");
		expect((await post(event("email.complaint", target))).status).toBe(200);
		expect(await isSuppressedByApp(target)).toBe(true);
		const [row] = await ownerRows<{ reason: string }>(`SELECT reason FROM email_suppression WHERE email_hash = $1`, [
			hash(target),
		]);
		expect(row?.reason).toBe("complaint");
		const count = await suppressedCount();
		expect((await post(event("email.complaint", target))).status).toBe(200);
		expect((await post(event("email.bounce", target, { bounceType: "Permanent" }))).status).toBe(200);
		expect(await suppressedCount()).toBe(count);
	});

	describe("the app role", () => {
		it("cannot read or write email_suppression directly", async () => {
			const h = hash(address("direct"));
			await expect(app.query(`SELECT * FROM email_suppression`)).rejects.toThrow(/permission denied/);
			await expect(app.query(`SELECT count(*) FROM email_suppression`)).rejects.toThrow(/permission denied/);
			await expect(
				app.query(`INSERT INTO email_suppression (email_hash, reason) VALUES ($1, 'bounce')`, [h]),
			).rejects.toThrow(/permission denied/);
			await expect(app.query(`UPDATE email_suppression SET reason = 'complaint'`)).rejects.toThrow(/permission denied/);
			await expect(app.query(`DELETE FROM email_suppression`)).rejects.toThrow(/permission denied/);
			await expect(app.query(`TRUNCATE email_suppression`)).rejects.toThrow(/permission denied/);
		});

		it("reaches the list only through two definer functions with a pinned search_path", async () => {
			const functions = await ownerRows<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
				`SELECT proname, prosecdef, proconfig FROM pg_proc
				 WHERE proname IN ('careeros_email_is_suppressed', 'careeros_email_suppress') ORDER BY proname`,
			);
			expect(functions.map((f) => f.proname)).toEqual(["careeros_email_is_suppressed", "careeros_email_suppress"]);
			for (const f of functions) {
				expect(f.prosecdef).toBe(true);
				expect(f.proconfig).toContain("search_path=pg_catalog, public");
			}
			const policies = await ownerRows<{ policyname: string; roles: string[] }>(
				`SELECT policyname, roles FROM pg_policies WHERE tablename = 'email_suppression'`,
			);
			expect(policies.flatMap((p) => p.roles)).not.toContain("careeros_app");
			const [rls] = await ownerRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
				`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'email_suppression'`,
			);
			expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
		});

		it("is refused a malformed hash, an unknown reason and a malformed provider id", async () => {
			const h = hash(address("bad-input"));
			await expect(app.query(`SELECT careeros_email_suppress('not-a-hash', 'bounce', NULL)`)).rejects.toThrow(
				/invalid hash/,
			);
			await expect(app.query(`SELECT careeros_email_suppress($1, 'spam', NULL)`, [h])).rejects.toThrow(
				/invalid reason/,
			);
			await expect(app.query(`SELECT careeros_email_suppress($1, 'bounce', 'has spaces')`, [h])).rejects.toThrow(
				/invalid provider email id/,
			);
			expect(await isSuppressedByApp(address("bad-input"))).toBe(false);
		});
	});

	describe("sending through Plunk", () => {
		const fetchMock = vi.fn<typeof fetch>();

		it("skips a suppressed recipient and sends to everyone else, with no real network", async () => {
			fetchMock.mockReset().mockImplementation(async () => Response.json({ data: { emails: [{ email: "email_9" }] } }));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const { sendTestEmail } = await import("@reactive-resume/email/test-send");
				const suppressed = address("bounce");
				expect(await sendTestEmail(suppressed)).toEqual({ provider: "plunk", outcome: "suppressed" });
				expect(fetchMock).not.toHaveBeenCalled();
				const fresh = address("fresh");
				expect(await sendTestEmail(fresh)).toMatchObject({ provider: "plunk", outcome: "queued", emailId: "email_9" });
				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://next-api.useplunk.com/v1/send");
			} finally {
				vi.unstubAllGlobals();
			}
		});
	});
});
