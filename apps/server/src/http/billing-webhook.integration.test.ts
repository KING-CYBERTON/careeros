import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";

// P3-T04: the billing webhook and the fake provider's test page end to end: the real Hono app, the real host resolver,
// the real Better Auth and oRPC stack, and the `careeros_app` role on a database of its own with every migration
// applied. It also stands in for the e2e smoke, which cannot run the fake provider because the e2e server runs with
// NODE_ENV=production (see docs/questions.md Q240). Skipped only when the CAREEROS_TEST_* variables are absent.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

vi.unmock("@careeros/tenancy");
vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

const SECRET = "integration-fake-secret-0123456789";
const PASSWORD = "correct-horse-battery";
const PLATFORM = "localhost:3000";
const PLATFORM_ORIGIN = `http://${PLATFORM}`;
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!configured)("billing webhook and the fake provider", () => {
	const run = randomUUID().slice(0, 8);
	const orgs = { a: `bw-a-${run}`, b: `bw-b-${run}`, c: `bw-c-${run}` };
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let queries = 0;
	let hono: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
	let auth: typeof import("@reactive-resume/auth/config").auth;

	const call = async (url: string, init: RequestInit = {}) => await hono.request(url, init);
	const ownerRows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
		(await owner.query<T>(sql, params)).rows;
	const org = async (id: string) =>
		(
			await ownerRows<{ status: string; plan_id: string; sub_status: string; seats: number; provider: string }>(
				`SELECT o.status, o.plan_id, s.status AS sub_status, s.seats, s.provider FROM organization o JOIN subscription s ON s.organization_id = o.id WHERE o.id = $1`,
				[id],
			)
		)[0];
	const eventCount = async () =>
		Number((await ownerRows<{ n: string }>(`SELECT count(*)::text AS n FROM billing_event`))[0]?.n);
	const auditCount = async () =>
		Number((await ownerRows<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log`))[0]?.n);

	const body = (orgId: string, overrides: Record<string, unknown> = {}) => ({
		id: `fake_evt_${randomUUID()}`,
		type: "checkout.completed",
		created: Math.floor(Date.now() / 1000),
		metadata: { orgId },
		data: {
			planId: "starter",
			seats: 10,
			interval: "month",
			periodStart: new Date().toISOString(),
			periodEnd: new Date(Date.now() + 30 * DAY).toISOString(),
			amount: 4900,
			currency: "USD",
		},
		...overrides,
	});
	// The fake provider's documented format, written out here on purpose: `x-fake-signature: t=<seconds>,v1=<hmac>`, the
	// HMAC-SHA256 of `<seconds>.<raw body>` under BILLING_FAKE_SECRET.
	const signed = (payload: unknown, secret = SECRET) => {
		const text = JSON.stringify(payload);
		const t = Math.floor(Date.now() / 1000);
		return {
			rawBody: new TextEncoder().encode(text),
			headers: new Headers({
				"content-type": "application/json",
				"x-fake-signature": `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${text}`).digest("hex")}`,
			}),
		};
	};
	const post = (
		signedEvent: { rawBody: Uint8Array; headers: Headers },
		host = PLATFORM,
		path = "/api/billing/webhook/fake",
	) =>
		call(`http://${host}${path}`, {
			method: "POST",
			headers: { host, ...Object.fromEntries(signedEvent.headers.entries()) },
			body: signedEvent.rawBody as BodyInit,
		});

	const platformUser = async (label = "u") => {
		const suffix = randomUUID().slice(0, 8);
		const email = `${label}-${suffix}@example.test`;
		const response = await auth.handler(
			new Request(`${PLATFORM_ORIGIN}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { host: PLATFORM, "content-type": "application/json", origin: PLATFORM_ORIGIN },
				body: JSON.stringify({ name: label, email, password: PASSWORD, username: `${label}-${suffix}` }),
			}),
		);
		expect(response.status).toBe(200);
		const cookie = response.headers
			.getSetCookie()
			.map((line) => line.split(";", 1)[0])
			.filter((pair) => !pair?.endsWith("="))
			.join("; ");
		const [row] = await ownerRows<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
		const [member] = await ownerRows<{ organization_id: string }>(
			`SELECT organization_id FROM member WHERE user_id = $1`,
			[row?.id],
		);
		return { cookie, userId: row?.id ?? "", orgId: member?.organization_id ?? "" };
	};
	const rest = (cookie: string, path: string, method = "GET", data?: unknown) =>
		call(`${PLATFORM_ORIGIN}/api/openapi${path}`, {
			method,
			headers: {
				host: PLATFORM,
				cookie,
				origin: PLATFORM_ORIGIN,
				...(data === undefined ? {} : { "content-type": "application/json" }),
			},
			...(data === undefined ? {} : { body: JSON.stringify(data) }),
		});

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("billing_web_t04");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.ORG_HOST_PATTERN = "{slug}.orgs.test";
		process.env.APP_URL = PLATFORM_ORIGIN;
		process.env.BILLING_PROVIDER = "fake";
		process.env.BILLING_FAKE_SECRET = SECRET;
		process.env.TRUST_FORWARDED_HOST = "false";
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		// Counts every query and connection the application makes, so "nothing touches the database" can be asserted.
		const counting = new Proxy(app, {
			get(target, property, _receiver) {
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
		for (const id of Object.values(orgs))
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [id]);
		({ auth } = await import("@reactive-resume/auth/config"));
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

	describe("the webhook", () => {
		it("applies a correctly signed event on the platform host and answers 200", async () => {
			const response = await post(signed(body(orgs.a)));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ received: true, outcome: "applied" });
			expect(await org(orgs.a)).toMatchObject({
				status: "active",
				plan_id: "starter",
				sub_status: "active",
				seats: 10,
				provider: "fake",
			});
		});

		it("answers 200 for a duplicate and changes nothing", async () => {
			const payload = body(orgs.b);
			expect((await post(signed(payload))).status).toBe(200);
			const before = { org: await org(orgs.b), events: await eventCount(), audit: await auditCount() };
			const again = await post(signed({ ...payload, data: { ...(payload.data as object), seats: 77 } }));
			expect(again.status).toBe(200);
			expect(await again.json()).toEqual({ received: true, outcome: "duplicate" });
			expect({ org: await org(orgs.b), events: await eventCount(), audit: await auditCount() }).toEqual(before);
		});

		it("answers 200 for a signed event type it ignores, recording nothing", async () => {
			const before = await eventCount();
			const response = await post(signed(body(orgs.c, { type: "invoice.created" })));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ received: true, outcome: "ignored" });
			expect(await eventCount()).toBe(before);
			expect((await org(orgs.c))?.plan_id).toBe("personal");
		});

		it("refuses a bad signature with 400 and never touches the database", async () => {
			const good = signed(body(orgs.c));
			const wrongSecret = signed(body(orgs.c), "another-secret-0123456789abcdef");
			const tampered = {
				rawBody: new TextEncoder().encode(new TextDecoder().decode(good.rawBody).replace(orgs.c, orgs.a)),
				headers: good.headers,
			};
			const noHeader = { rawBody: good.rawBody, headers: new Headers({ "content-type": "application/json" }) };
			const garbage = {
				rawBody: new TextEncoder().encode("{}"),
				headers: new Headers({ "x-fake-signature": "t=1,v1=zz" }),
			};
			const before = { org: await org(orgs.c), events: await eventCount(), audit: await auditCount() };
			const queriesBefore = queries;
			for (const attempt of [wrongSecret, tampered, noHeader, garbage]) {
				const response = await post(attempt);
				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({ code: "BAD_SIGNATURE" });
			}
			expect(queries).toBe(queriesBefore);
			expect({ org: await org(orgs.c), events: await eventCount(), audit: await auditCount() }).toEqual(before);
		});

		it("refuses a validly signed event whose payload is unusable with 400, still without a database query", async () => {
			const queriesBefore = queries;
			const response = await post(signed(body(orgs.c, { metadata: {} })));
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ code: "BAD_PAYLOAD" });
			expect(queries).toBe(queriesBefore);
		});

		it("takes the organization from the verified metadata, not from other fields of the body", async () => {
			const crafted = body(orgs.c, {
				orgId: orgs.a,
				organizationId: orgs.a,
				customer: { metadata: { orgId: orgs.a } },
			});
			const before = await org(orgs.a);
			expect((await post(signed(crafted))).status).toBe(200);
			expect(await org(orgs.c)).toMatchObject({ status: "active", plan_id: "starter" });
			expect(await org(orgs.a)).toEqual(before);
		});

		it("is refused on an organization host, a custom-domain-shaped host and an unknown host, changing nothing", async () => {
			const payload = signed(body(orgs.a, { type: "payment.failed", data: {} }));
			const before = { org: await org(orgs.a), events: await eventCount() };
			for (const host of [
				`${orgs.b}.orgs.test`,
				`${orgs.a}.orgs.test`,
				"evil.example.test",
				`nobody-${run}.orgs.test`,
			]) {
				const response = await post(payload, host);
				expect(response.status, host).toBe(404);
			}
			expect({ org: await org(orgs.a), events: await eventCount() }).toEqual(before);
			// The same request on the platform host is accepted: the host was the only difference.
			expect((await post(payload)).status).toBe(200);
		});

		it("caps the body at 256 KB (413), before reading it", async () => {
			const huge = new Uint8Array(256 * 1024 + 1).fill(97);
			const queriesBefore = queries;
			const response = await post({ rawBody: huge, headers: new Headers({ "content-type": "application/json" }) });
			expect(response.status).toBe(413);
			expect(queries).toBe(queriesBefore);
			// Just under the cap reaches the signature check and fails there.
			const fits = new Uint8Array(256 * 1024).fill(97);
			expect((await post({ rawBody: fits, headers: new Headers() })).status).toBe(400);
		});

		it("answers 404 for a provider that is not the configured one, and for the manual provider", async () => {
			for (const provider of ["stripe", "paystack", "manual", "unknown", "FAKE"]) {
				const response = await post(signed(body(orgs.c)), PLATFORM, `/api/billing/webhook/${provider}`);
				expect(response.status, provider).toBe(404);
			}
		});

		it("answers 500 for a real processing error, so the provider retries, then succeeds on the retry", async () => {
			const payload = body(orgs.c, { type: "payment.succeeded", data: { planId: "no-such-plan" } });
			const failed = await post(signed(payload));
			expect(failed.status).toBe(500);
			expect(await failed.json()).toEqual({ code: "PROCESSING_ERROR" });
			const [row] = await ownerRows<{ outcome: string }>(
				`SELECT outcome FROM billing_event WHERE provider_event_id = $1`,
				[payload.id],
			);
			expect(row?.outcome).toBe("error");
			const retried = await post(signed({ ...payload, data: { planId: "starter", seats: 4 } }));
			expect(retried.status).toBe(200);
		});
	});

	describe("the fake provider test page and the owner's billing procedures", () => {
		it("starts a trial, checks out Starter with 10 seats, approves, and the organization is active", async () => {
			const user = await platformUser("owner");
			const before = await rest(user.cookie, "/billing");
			expect(before.status).toBe(200);
			expect(await before.json()).toMatchObject({
				planId: "personal",
				status: "active",
				billingEnabled: true,
				canManage: true,
				canStartTrial: true,
			});

			const trial = await rest(user.cookie, "/billing/trial", "POST", {});
			expect(trial.status).toBe(200);
			expect(await org(user.orgId)).toMatchObject({ status: "trial", plan_id: "trial", seats: 5 });
			expect((await rest(user.cookie, "/billing/trial", "POST", {})).status).toBe(409);

			const checkout = await rest(user.cookie, "/billing/checkout", "POST", {
				planId: "starter",
				interval: "month",
				seats: 10,
			});
			expect(checkout.status).toBe(200);
			const { redirectUrl, stkPushRequested } = (await checkout.json()) as {
				redirectUrl: string;
				stkPushRequested: boolean;
			};
			expect(stkPushRequested).toBe(false);
			const url = new URL(redirectUrl);
			expect(url.pathname).toBe("/api/billing/fake/checkout");

			const page = await call(`${PLATFORM_ORIGIN}${url.pathname}${url.search}`, { headers: { host: PLATFORM } });
			expect(page.status).toBe(200);
			const html = await page.text();
			expect(html).toContain("Approve payment");
			expect(html).toContain("Decline payment");
			expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");

			const token = url.searchParams.get("session") ?? "";
			const decide = (decision: string, origin: string | null = PLATFORM_ORIGIN, session = token) =>
				call(`${PLATFORM_ORIGIN}/api/billing/fake/decision`, {
					method: "POST",
					headers: {
						host: PLATFORM,
						"content-type": "application/x-www-form-urlencoded",
						...(origin ? { origin } : {}),
					},
					body: new URLSearchParams({ session, decision }).toString(),
				});
			// A cross-site form, a forged token and a missing decision are all refused before any event is posted.
			expect((await decide("approve", "https://evil.example")).status).toBe(403);
			expect((await decide("approve", null)).status).toBe(403);
			expect((await decide("approve", PLATFORM_ORIGIN, `${token}x`)).status).toBe(400);
			expect((await decide("maybe")).status).toBe(400);
			expect((await org(user.orgId))?.plan_id).toBe("trial");

			const approved = await decide("approve");
			expect(approved.status).toBe(303);
			expect(approved.headers.get("location")).toBe(`${PLATFORM_ORIGIN}/dashboard?billing=approved`);
			expect(await org(user.orgId)).toMatchObject({
				status: "active",
				plan_id: "starter",
				sub_status: "active",
				seats: 10,
				provider: "fake",
			});
			const view = (await (await rest(user.cookie, "/billing")).json()) as {
				status: string;
				subscription: { seats: number; status: string };
			};
			expect(view.status).toBe("active");
			expect(view.subscription).toMatchObject({ seats: 10, status: "active" });
			// Approving the same page twice posts a second event with a new id: the state is the same.
			expect((await decide("approve")).status).toBe(303);
			expect(await org(user.orgId)).toMatchObject({ status: "active", seats: 10 });

			// Add seats and cancel through the provider; the intake applies what the provider confirms.
			const seats = await rest(user.cookie, "/billing/seats", "POST", { seats: 20 });
			expect(seats.status).toBe(200);
			expect((await org(user.orgId))?.seats).toBe(20);
			expect((await rest(user.cookie, "/billing/seats", "POST", { seats: 0 })).status).toBe(400);

			// A declined payment on an active subscription puts the organization past due.
			const declined = await decide("decline");
			expect(declined.status).toBe(303);
			expect(await org(user.orgId)).toMatchObject({ status: "past_due", sub_status: "past_due" });

			const cancel = await rest(user.cookie, "/billing/cancel", "POST", {});
			expect(cancel.status).toBe(200);
			expect((await org(user.orgId))?.sub_status).toBe("canceled");
			expect((await rest(user.cookie, "/billing/portal", "POST", {})).status).toBe(412);
		}, 60_000);

		it("refuses seats below the member count at checkout, and refuses non-owners", async () => {
			const user = await platformUser("tight");
			const second = await platformUser("second");
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
				`bw-m-${randomUUID()}`,
				user.orgId,
				second.userId,
			]);
			const members = Number(
				(
					await ownerRows<{ n: string }>(`SELECT count(*)::text AS n FROM member WHERE organization_id = $1`, [
						user.orgId,
					])
				)[0]?.n,
			);
			expect(members).toBe(2);
			expect(
				(await rest(user.cookie, "/billing/checkout", "POST", { planId: "starter", interval: "month", seats: 1 }))
					.status,
			).toBe(400);
			expect(
				(await rest(user.cookie, "/billing/checkout", "POST", { planId: "starter", interval: "month", seats: 2 }))
					.status,
			).toBe(200);
			// Plans that are not sold online, and seats over a plan's limit.
			expect(
				(await rest(user.cookie, "/billing/checkout", "POST", { planId: "enterprise", interval: "month", seats: 2 }))
					.status,
			).toBe(400);
			expect(
				(await rest(user.cookie, "/billing/checkout", "POST", { planId: "starter", interval: "month", seats: 51 }))
					.status,
			).toBe(400);
			// The other member of that organization is not an owner or admin: no read, no write. Their own cookie, their own
			// personal organization, so they are an owner there; pin the active organization to the first one.
			await owner.query(`UPDATE session SET active_organization_id = $1 WHERE user_id = $2`, [
				user.orgId,
				second.userId,
			]);
			expect((await rest(second.cookie, "/billing")).status).toBe(403);
			expect(
				(await rest(second.cookie, "/billing/checkout", "POST", { planId: "starter", interval: "month", seats: 5 }))
					.status,
			).toBe(403);
			expect((await rest(second.cookie, "/billing/trial", "POST", {})).status).toBe(403);
			// Admins read; they cannot write.
			await owner.query(`UPDATE member SET role = 'admin' WHERE organization_id = $1 AND user_id = $2`, [
				user.orgId,
				second.userId,
			]);
			expect((await rest(second.cookie, "/billing")).status).toBe(200);
			expect(
				(await rest(second.cookie, "/billing/checkout", "POST", { planId: "starter", interval: "month", seats: 5 }))
					.status,
			).toBe(403);
			expect((await rest(second.cookie, "/billing/cancel", "POST", {})).status).toBe(403);
		}, 60_000);

		it("lets a suspended organization's owner check out (fake provider) while another write is refused with ORG_SUSPENDED", async () => {
			const user = await platformUser("suspended");
			await owner.query(`UPDATE organization SET status = 'suspended' WHERE id = $1`, [user.orgId]);
			const refused = await rest(user.cookie, "/resumes", "POST", { name: "Blocked" });
			expect(refused.status).toBe(403);
			expect(JSON.stringify(await refused.json())).toContain("ORG_SUSPENDED");
			expect((await rest(user.cookie, "/billing")).status).toBe(200);
			const checkout = await rest(user.cookie, "/billing/checkout", "POST", {
				planId: "starter",
				interval: "month",
				seats: 2,
			});
			expect(checkout.status).toBe(200);
			expect(new URL(((await checkout.json()) as { redirectUrl: string }).redirectUrl).pathname).toBe(
				"/api/billing/fake/checkout",
			);
		}, 60_000);

		it("answers 404 for the test page on an organization host and for a forged or expired session", async () => {
			const user = await platformUser("page");
			const checkout = await rest(user.cookie, "/billing/checkout", "POST", {
				planId: "starter",
				interval: "month",
				seats: 1,
			});
			const url = new URL(((await checkout.json()) as { redirectUrl: string }).redirectUrl);
			const onOrgHost = await call(`http://${orgs.a}.orgs.test${url.pathname}${url.search}`, {
				headers: { host: `${orgs.a}.orgs.test` },
			});
			expect(onOrgHost.status).toBe(404);
			const forged = await call(`${PLATFORM_ORIGIN}${url.pathname}?session=${url.searchParams.get("session")}x`, {
				headers: { host: PLATFORM },
			});
			expect(forged.status).toBe(400);
			const none = await call(`${PLATFORM_ORIGIN}${url.pathname}`, { headers: { host: PLATFORM } });
			expect(none.status).toBe(400);
		});
	});
});
