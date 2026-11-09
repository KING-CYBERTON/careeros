import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";

// P3-T05: the Paystack provider end to end: the real Hono app, the real host resolver, Better Auth and oRPC stack, the
// real webhook route and intake, and the `careeros_app` role on a database of its own with every migration applied.
// Paystack's HTTP API is mocked (a `fetch` stand-in answering what api.paystack.co answers, shaped like Paystack's docs);
// there is no network. Skipped only when the CAREEROS_TEST_* variables are absent (the skipped-suite guard catches that).
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

vi.unmock("@careeros/tenancy");
// The mail transport is replaced with a recorder (set up in beforeAll, after the module registry is reset).
const sendEmail = vi.fn(async (_options: { to: string; subject: string }) => undefined);

const SECRET = "sk_test_integration_secret_key_0000";
const PUBLIC = "pk_test_integration_public_key_0000";
const PASSWORD = "correct-horse-battery";
const PLATFORM = "localhost:3000";
const PLATFORM_ORIGIN = `http://${PLATFORM}`;
const DAY = 24 * 60 * 60 * 1000;

// What the plan table says (seeded placeholder prices): Starter is flat KES 6,500 a month; Pro is KES 1,500 per seat.
const STARTER_MONTH = 6500 * 100;
const PRO_4_SEATS = 1500 * 4 * 100;

type PaystackCall = { method: string; path: string; body: Record<string, unknown> | null };

describe.skipIf(!configured)("the Paystack provider", () => {
	const run = randomUUID().slice(0, 8);
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let hono: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
	let auth: typeof import("@reactive-resume/auth/config").auth;
	let apiBilling: typeof import("@reactive-resume/api/features/billing");
	const realFetch = globalThis.fetch;

	// --- The mocked Paystack API ------------------------------------------------------------------------------------
	const calls: PaystackCall[] = [];
	let planCounter = 0;
	const verifications = new Map<string, Record<string, unknown>>();
	const subscriptions = new Map<string, Record<string, unknown>>();
	let verifyDown = false;

	const reply = (data: unknown, status = 200) =>
		new Response(JSON.stringify({ status: status < 400, message: status < 400 ? "ok" : "refused", data }), { status });

	const paystackFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		if (url.hostname !== "api.paystack.co") return await realFetch(input, init);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		calls.push({ method, path: url.pathname, body });
		expect(((init?.headers ?? {}) as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
		const path = url.pathname;
		if (method === "POST" && path === "/plan")
			return reply({ plan_code: `PLN_it${run}${++planCounter}`, id: planCounter });
		if (method === "POST" && path === "/transaction/initialize")
			return reply({
				authorization_url: `https://checkout.paystack.com/${randomUUID().slice(0, 10)}`,
				access_code: "ac",
				reference: `ref_${randomUUID().slice(0, 12)}`,
			});
		if (method === "GET" && path.startsWith("/transaction/verify/")) {
			if (verifyDown) return reply(null, 503);
			const found = verifications.get(decodeURIComponent(path.split("/").pop() ?? ""));
			return found ? reply(found) : reply(null, 404);
		}
		if (method === "POST" && path === "/subscription")
			return reply({ subscription_code: `SUB_new${run}${++planCounter}` });
		if (method === "POST" && path === "/subscription/disable") return reply({});
		if (method === "GET" && path.endsWith("/manage/link")) return reply({ link: "https://paystack.com/manage/it" });
		if (method === "GET" && path.startsWith("/subscription/")) {
			const found = subscriptions.get(decodeURIComponent(path.split("/").pop() ?? ""));
			return found ? reply(found) : reply(null, 404);
		}
		return reply(null, 404);
	};
	const callsTo = (method: string, path: string) =>
		calls.filter((c) => c.method === method && (c.path === path || c.path.startsWith(path)));

	// --- Helpers ------------------------------------------------------------------------------------------------------
	const ownerRows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
		(await owner.query<T>(sql, params)).rows;
	const orgState = async (id: string) =>
		(
			await ownerRows<{
				status: string;
				plan_id: string;
				sub_status: string;
				seats: number;
				provider: string;
				customer: string | null;
				subscription: string | null;
				period_end: Date | null;
				grace: Date | null;
				pending_seats: number | null;
			}>(
				`SELECT o.status, o.plan_id, s.status AS sub_status, s.seats, s.provider, s.provider_customer_id AS customer,
					s.provider_subscription_id AS subscription, s.current_period_end AS period_end, s.grace_ends_at AS grace,
					s.pending_seats FROM organization o JOIN subscription s ON s.organization_id = o.id WHERE o.id = $1`,
				[id],
			)
		)[0];
	const eventCount = async () =>
		Number((await ownerRows<{ n: string }>(`SELECT count(*)::text AS n FROM billing_event`))[0]?.n);
	const auditCount = async () =>
		Number((await ownerRows<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log`))[0]?.n);

	const sign = (payload: unknown, secret = SECRET) => {
		const rawBody = new TextEncoder().encode(JSON.stringify(payload));
		return {
			rawBody,
			// The documented format, written out on purpose: the HMAC SHA512 of the raw body, hex.
			headers: new Headers({
				"content-type": "application/json",
				"x-paystack-signature": createHmac("sha512", secret).update(rawBody).digest("hex"),
			}),
		};
	};
	const post = (signedEvent: { rawBody: Uint8Array; headers: Headers }, host = PLATFORM) =>
		Promise.resolve(
			hono.request(`http://${host}/api/billing/webhook/paystack`, {
				method: "POST",
				headers: { host, ...Object.fromEntries(signedEvent.headers.entries()) },
				body: signedEvent.rawBody as BodyInit,
			}),
		);

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
		await owner.query(`UPDATE "user" SET email_verified = true WHERE id = $1`, [row?.id]);
		return { cookie, userId: row?.id ?? "", orgId: member?.organization_id ?? "", email };
	};
	const rest = async (cookie: string, path: string, method = "GET", data?: unknown) =>
		await hono.request(`${PLATFORM_ORIGIN}/api/openapi${path}`, {
			method,
			headers: {
				host: PLATFORM,
				cookie,
				origin: PLATFORM_ORIGIN,
				...(data === undefined ? {} : { "content-type": "application/json" }),
			},
			...(data === undefined ? {} : { body: JSON.stringify(data) }),
		});

	/** Checks out through the real API and returns the transaction Paystack was asked to start. */
	const checkout = async (
		user: { cookie: string },
		input: { planId: string; interval: "month" | "year"; seats: number; method?: "card" | "mpesa" },
	) => {
		const before = calls.length;
		const response = await rest(user.cookie, "/billing/checkout", "POST", input);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { redirectUrl: string | null };
		expect(body.redirectUrl).toMatch(/^https:\/\/checkout\.paystack\.com\//);
		const init = calls.slice(before).find((c) => c.path === "/transaction/initialize");
		expect(init).toBeDefined();
		return init?.body as Record<string, unknown>;
	};

	let chargeId = 700_000;
	/** The charge.success Paystack would send for a started transaction, and its record for `verify`. */
	const charge = (
		init: Record<string, unknown>,
		overrides: {
			amount?: number;
			verified?: Record<string, unknown>;
			customer?: string;
			extra?: Record<string, unknown>;
		} = {},
	) => {
		const reference = `ref_${randomUUID().slice(0, 12)}`;
		const amount = overrides.amount ?? (init.amount as number);
		const planCode = typeof init.plan === "string" ? init.plan : null;
		verifications.set(reference, {
			id: ++chargeId,
			status: "success",
			reference,
			amount,
			currency: "KES",
			...overrides.verified,
		});
		return {
			event: "charge.success",
			data: {
				id: chargeId,
				status: "success",
				reference,
				amount,
				currency: "KES",
				channel: planCode ? "card" : "mobile_money",
				paid_at: new Date().toISOString(),
				customer: { customer_code: overrides.customer ?? `CUS_${run}`, email: "payer@example.test" },
				plan: planCode ? { plan_code: planCode, interval: "monthly", amount, currency: "KES" } : {},
				metadata: init.metadata,
				...overrides.extra,
			},
		};
	};

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("billing_paystack_t05");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.ORG_HOST_PATTERN = "{slug}.orgs.test";
		process.env.APP_URL = PLATFORM_ORIGIN;
		process.env.BILLING_PROVIDER = "paystack";
		process.env.PAYSTACK_SECRET_KEY = SECRET;
		process.env.PAYSTACK_PUBLIC_KEY = PUBLIC;
		process.env.TRUST_FORWARDED_HOST = "false";
		vi.resetModules();
		vi.stubGlobal("fetch", paystackFetch);
		vi.doMock(new URL("../../../../packages/email/src/transport.ts", import.meta.url).pathname, () => ({
			sendEmail: (options: { to: string; subject: string }) => sendEmail(options),
		}));
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		({ auth } = await import("@reactive-resume/auth/config"));
		apiBilling = await import("@reactive-resume/api/features/billing");
		const { createApp } = await import("./app");
		hono = createApp({ serveStatic: false, trustedClient: () => "203.0.113.9" });
	}, 180_000);

	afterAll(async () => {
		vi.unstubAllGlobals();
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	describe("card: checkout, subscription, renewal, failure and cancel", () => {
		it("starts a card checkout on a plan made for this price, then charge.success makes the organization active", async () => {
			const user = await platformUser("card");
			const init = await checkout(user, { planId: "starter", interval: "month", seats: 10, method: "card" });
			expect(init).toMatchObject({ currency: "KES", amount: STARTER_MONTH, channels: ["card"], email: user.email });
			expect(init.plan).toMatch(/^PLN_it/);
			expect(init.callback_url).toBe(`${PLATFORM_ORIGIN}/dashboard`);
			expect(callsTo("POST", "/plan").at(-1)?.body).toMatchObject({ interval: "monthly", amount: STARTER_MONTH });

			const response = await post(sign(charge(init, { customer: `CUS_${user.userId.slice(-10)}` })));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ received: true, outcome: "applied" });
			const state = await orgState(user.orgId);
			expect(state).toMatchObject({
				status: "active",
				plan_id: "starter",
				sub_status: "active",
				seats: 10,
				provider: "paystack",
				customer: `CUS_${user.userId.slice(-10)}`,
			});
			expect(state?.period_end && state.period_end.getTime() > Date.now() + 25 * DAY).toBe(true);
			// Paystack itself confirmed the payment before the organization changed.
			expect(callsTo("GET", "/transaction/verify/").length).toBeGreaterThan(0);
		});

		it("subscription.create records the provider subscription and a later card renewal extends the period", async () => {
			const user = await platformUser("renew");
			const customer = `CUS_${user.userId.slice(-10)}`;
			const init = await checkout(user, { planId: "starter", interval: "month", seats: 10 });
			await post(sign(charge(init, { customer })));
			const code = `SUB_${user.userId.slice(-10)}`;
			const created = await post(
				sign({
					event: "subscription.create",
					data: {
						id: Math.floor(Math.random() * 1e6),
						status: "active",
						subscription_code: code,
						customer: { customer_code: customer },
					},
				}),
			);
			expect(created.status).toBe(200);
			expect((await orgState(user.orgId))?.subscription).toBe(code);

			// A month on: Paystack charges the card by itself. The charge has the plan and no checkout metadata.
			const firstEnd = (await orgState(user.orgId))?.period_end as Date;
			const renewal = charge({ ...init, metadata: "" }, { customer, extra: { paid_at: firstEnd.toISOString() } });
			expect((await post(sign(renewal))).status).toBe(200);
			const renewed = await orgState(user.orgId);
			expect(renewed?.period_end && renewed.period_end.getTime() > firstEnd.getTime() + 25 * DAY).toBe(true);
			expect(renewed).toMatchObject({ status: "active", seats: 10 });
		});

		it("invoice.payment_failed puts the organization in the grace period", async () => {
			const user = await platformUser("fail");
			const customer = `CUS_${user.userId.slice(-10)}`;
			const code = `SUB_${user.userId.slice(-10)}`;
			await post(sign(charge(await checkout(user, { planId: "starter", interval: "month", seats: 5 }), { customer })));
			await post(
				sign({
					event: "subscription.create",
					data: { id: 1, subscription_code: code, customer: { customer_code: customer } },
				}),
			);
			const failed = await post(
				sign({
					event: "invoice.payment_failed",
					data: {
						invoice_code: `INV_${run}_${user.userId.slice(-6)}`,
						amount: STARTER_MONTH,
						subscription: { subscription_code: code },
						customer: { customer_code: customer },
					},
				}),
			);
			expect(failed.status).toBe(200);
			const state = await orgState(user.orgId);
			expect(state).toMatchObject({ status: "past_due", sub_status: "past_due" });
			expect(state?.grace && state.grace.getTime() > Date.now() + 6 * DAY).toBe(true);
		});

		it("cancel disables the card subscription at Paystack, and its event ends it at the period end", async () => {
			const user = await platformUser("cancel");
			const customer = `CUS_${user.userId.slice(-10)}`;
			const code = `SUB_${user.userId.slice(-10)}`;
			await post(sign(charge(await checkout(user, { planId: "starter", interval: "month", seats: 5 }), { customer })));
			await post(
				sign({
					event: "subscription.create",
					data: { id: 2, subscription_code: code, customer: { customer_code: customer } },
				}),
			);
			subscriptions.set(code, {
				subscription_code: code,
				email_token: "tok_it",
				status: "active",
				next_payment_date: new Date(Date.now() + 20 * DAY).toISOString(),
				customer: { customer_code: customer },
				authorization: { authorization_code: "AUTH_it" },
			});
			const before = calls.length;
			expect((await rest(user.cookie, "/billing/cancel", "POST", {})).status).toBe(200);
			expect(calls.slice(before).find((c) => c.path === "/subscription/disable")?.body).toEqual({
				code,
				token: "tok_it",
			});

			const disabled = await post(
				sign({
					event: "subscription.disable",
					data: { id: 3, subscription_code: code, customer: { customer_code: customer } },
				}),
			);
			expect(disabled.status).toBe(200);
			expect(await orgState(user.orgId)).toMatchObject({ status: "active", sub_status: "canceled" });
			// The job ends it once the paid period has passed.
			const { runBillingJobs } = apiBilling;
			const result = await runBillingJobs({ now: new Date(Date.now() + 40 * DAY) });
			expect(result.changed).toBeGreaterThan(0);
			expect((await orgState(user.orgId))?.status).toBe("suspended");
		});

		it("the manage link comes from Paystack for a card subscription", async () => {
			const user = await platformUser("portal");
			const customer = `CUS_${user.userId.slice(-10)}`;
			const code = `SUB_${user.userId.slice(-10)}`;
			await post(sign(charge(await checkout(user, { planId: "starter", interval: "month", seats: 5 }), { customer })));
			await post(
				sign({
					event: "subscription.create",
					data: { id: 4, subscription_code: code, customer: { customer_code: customer } },
				}),
			);
			const response = await rest(user.cookie, "/billing/portal", "POST", {});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ url: "https://paystack.com/manage/it" });
		});

		it("a seat change starts a new subscription at the next period, and the old one's cancellation does not cancel the organization", async () => {
			const user = await platformUser("seats");
			const customer = `CUS_${user.userId.slice(-10)}`;
			const oldCode = `SUB_${user.userId.slice(-10)}`;
			const init = await checkout(user, { planId: "pro", interval: "month", seats: 4 });
			expect(init.amount).toBe(PRO_4_SEATS);
			await post(sign(charge(init, { customer })));
			await post(
				sign({
					event: "subscription.create",
					data: { id: 5, subscription_code: oldCode, customer: { customer_code: customer } },
				}),
			);
			subscriptions.set(oldCode, {
				subscription_code: oldCode,
				email_token: "tok_old",
				status: "active",
				next_payment_date: new Date(Date.now() + 20 * DAY).toISOString(),
				customer: { customer_code: customer },
				authorization: { authorization_code: "AUTH_it" },
			});
			const before = calls.length;
			expect((await rest(user.cookie, "/billing/seats", "POST", { seats: 6 })).status).toBe(200);
			const made = calls.slice(before);
			const created = made.find((c) => c.method === "POST" && c.path === "/subscription");
			expect(created?.body).toMatchObject({ customer, authorization: "AUTH_it" });
			expect(made.findIndex((c) => c.path === "/subscription")).toBeLessThan(
				made.findIndex((c) => c.path === "/subscription/disable"),
			);
			expect(await orgState(user.orgId)).toMatchObject({ seats: 4, pending_seats: 6, status: "active" });

			// Paystack now reports the old subscription disabled: that is the replacement, not a cancellation.
			const disabled = await post(
				sign({
					event: "subscription.disable",
					data: { id: 6, subscription_code: oldCode, customer: { customer_code: customer } },
				}),
			);
			expect(disabled.status).toBe(200);
			expect(await orgState(user.orgId)).toMatchObject({ status: "active", sub_status: "active", seats: 4 });

			// The new subscription's first charge, at the next period, carries the new seat count.
			const newPlan = created?.body?.plan as string;
			const renewal = charge(
				{ amount: PRO_4_SEATS * 1.5, plan: newPlan, metadata: "" },
				{ customer, extra: { paid_at: new Date(Date.now() + 20 * DAY).toISOString() } },
			);
			expect((await post(sign(renewal))).status).toBe(200);
			expect(await orgState(user.orgId)).toMatchObject({ seats: 6, pending_seats: null, status: "active" });
		});
	});

	describe("M-Pesa: one period at a time", () => {
		it("a mobile-money checkout, its payment, then expiry, grace, suspension and the reminders", async () => {
			const user = await platformUser("mpesa");
			const init = await checkout(user, { planId: "starter", interval: "month", seats: 8, method: "mpesa" });
			expect(init).toMatchObject({ channels: ["mobile_money"], currency: "KES", amount: STARTER_MONTH });
			expect(init).not.toHaveProperty("plan");

			expect((await post(sign(charge(init)))).status).toBe(200);
			const paid = await orgState(user.orgId);
			expect(paid).toMatchObject({
				status: "active",
				plan_id: "starter",
				seats: 8,
				provider: "paystack",
				subscription: null,
			});
			const periodEnd = paid?.period_end as Date;

			// Three days before the end: one reminder, to the owner, and not a second on the next pass. Other organizations
			// in this database that fall in the same window are reminded too, so only this owner's mail is counted.
			const runRenewalReminders = (options: { now: Date }) => apiBilling.runScheduledRenewalReminders(options.now);
			const mine = () => sendEmail.mock.calls.map((call) => call[0]).filter((mail) => mail.to === user.email);
			sendEmail.mockClear();
			const threeDaysOut = new Date(periodEnd.getTime() - 2.5 * DAY);
			await runRenewalReminders({ now: threeDaysOut });
			expect(mine()).toHaveLength(1);
			expect(mine()[0]?.subject).toContain("plan ends on");
			await runRenewalReminders({ now: new Date(threeDaysOut.getTime() + 3600_000) });
			expect(mine()).toHaveLength(1);

			// The last day: a second, different reminder, once.
			const lastDay = new Date(periodEnd.getTime() - 6 * 3600_000);
			await runRenewalReminders({ now: lastDay });
			expect(mine()).toHaveLength(2);
			expect(mine()[1]?.subject).toContain("ends today");
			await runRenewalReminders({ now: new Date(lastDay.getTime() + 60_000) });
			expect(mine()).toHaveLength(2);

			// Not paid: the period ends, the grace period starts, then the organization is suspended.
			const { runBillingJobs } = apiBilling;
			await runBillingJobs({ now: new Date(periodEnd.getTime() + 1000) });
			const lapsed = await orgState(user.orgId);
			expect(lapsed).toMatchObject({ status: "past_due", sub_status: "past_due" });
			expect(lapsed?.grace && lapsed.grace.getTime() > periodEnd.getTime() + 6 * DAY).toBe(true);
			// No reminder for an organization that has already lapsed.
			await runRenewalReminders({ now: new Date(periodEnd.getTime() + 2000) });
			expect(mine()).toHaveLength(2);
			await runBillingJobs({ now: new Date(periodEnd.getTime() + 8 * DAY) });
			expect((await orgState(user.orgId))?.status).toBe("suspended");

			// Paying again brings it back, from the payment (the old period is over).
			const again = await checkout(user, { planId: "starter", interval: "month", seats: 8, method: "mpesa" });
			expect((await post(sign(charge(again)))).status).toBe(200);
			expect(await orgState(user.orgId)).toMatchObject({ status: "active", sub_status: "active" });
		});

		it("paying early for the next period starts it where the paid one ends", async () => {
			const user = await platformUser("early");
			expect(
				(
					await post(
						sign(charge(await checkout(user, { planId: "starter", interval: "month", seats: 3, method: "mpesa" }))),
					)
				).status,
			).toBe(200);
			const first = (await orgState(user.orgId))?.period_end as Date;
			expect(
				(
					await post(
						sign(charge(await checkout(user, { planId: "starter", interval: "month", seats: 3, method: "mpesa" }))),
					)
				).status,
			).toBe(200);
			const second = (await orgState(user.orgId))?.period_end as Date;
			expect(second.getTime() - first.getTime()).toBeGreaterThan(27 * DAY);
			expect(second.getTime() - first.getTime()).toBeLessThan(32 * DAY);
		});

		it("a seat change is recorded for the next payment, and cancelling means it is not paid again", async () => {
			const user = await platformUser("mseats");
			await post(sign(charge(await checkout(user, { planId: "pro", interval: "month", seats: 4, method: "mpesa" }))));
			const before = calls.length;
			expect((await rest(user.cookie, "/billing/seats", "POST", { seats: 7 })).status).toBe(200);
			expect(calls.slice(before)).toEqual([]);
			expect(await orgState(user.orgId)).toMatchObject({ seats: 4, pending_seats: 7 });
			// The next payment, for 7 seats, takes effect and clears the pending change.
			const next = await checkout(user, { planId: "pro", interval: "month", seats: 7, method: "mpesa" });
			expect((await post(sign(charge(next)))).status).toBe(200);
			expect(await orgState(user.orgId)).toMatchObject({ seats: 7, pending_seats: null });

			expect((await rest(user.cookie, "/billing/cancel", "POST", {})).status).toBe(200);
			expect(await orgState(user.orgId)).toMatchObject({ status: "active", sub_status: "canceled" });
			// Nothing was asked of Paystack, and the portal has nothing to show.
			expect(calls.slice(before).some((c) => c.path.startsWith("/subscription"))).toBe(false);
			expect((await rest(user.cookie, "/billing/portal", "POST", {})).status).toBe(412);
		});
	});

	describe("the webhook is refused when it should be", () => {
		it("answers 200 for a duplicate event and changes nothing", async () => {
			const user = await platformUser("dup");
			const event = charge(await checkout(user, { planId: "starter", interval: "month", seats: 2, method: "mpesa" }));
			expect((await post(sign(event))).status).toBe(200);
			const before = { org: await orgState(user.orgId), events: await eventCount(), audit: await auditCount() };
			const again = await post(sign(event));
			expect(again.status).toBe(200);
			expect(await again.json()).toEqual({ received: true, outcome: "duplicate" });
			expect({ org: await orgState(user.orgId), events: await eventCount(), audit: await auditCount() }).toEqual(
				before,
			);
		});

		it("refuses a forged event (bad signature) with 400 and changes nothing", async () => {
			const user = await platformUser("forged");
			const event = charge(await checkout(user, { planId: "starter", interval: "month", seats: 2, method: "mpesa" }));
			const good = sign(event);
			const before = { org: await orgState(user.orgId), events: await eventCount(), audit: await auditCount() };
			const callsBefore = calls.length;
			const tampered = {
				rawBody: new TextEncoder().encode(new TextDecoder().decode(good.rawBody).replace("success", "succes5")),
				headers: good.headers,
			};
			const attempts = [
				sign(event, "sk_test_another_secret_key_0000000"),
				tampered,
				{ rawBody: good.rawBody, headers: new Headers({ "content-type": "application/json" }) },
				{ rawBody: good.rawBody, headers: new Headers({ "x-paystack-signature": "00" }) },
			];
			for (const attempt of attempts) {
				const response = await post(attempt);
				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({ code: "BAD_SIGNATURE" });
			}
			// Nothing was confirmed with Paystack and nothing was written.
			expect(calls.length).toBe(callsBefore);
			expect({ org: await orgState(user.orgId), events: await eventCount(), audit: await auditCount() }).toEqual(
				before,
			);
			expect((await orgState(user.orgId))?.plan_id).toBe("personal");
		});

		it("takes the organization from the signed metadata even when unsigned fields name another one", async () => {
			const victim = await platformUser("victim");
			const payer = await platformUser("payer");
			const init = await checkout(payer, { planId: "starter", interval: "month", seats: 2, method: "mpesa" });
			const before = await orgState(victim.orgId);
			const event = charge(init, {
				extra: {
					organization_id: victim.orgId,
					orgId: victim.orgId,
					customer: { customer_code: "CUS_victim", email: "x@example.test", metadata: { orgId: victim.orgId } },
					custom_fields: [{ variable_name: "orgId", value: victim.orgId }],
				},
			});
			expect((await post(sign(event))).status).toBe(200);
			expect(await orgState(payer.orgId)).toMatchObject({ status: "active", plan_id: "starter" });
			expect(await orgState(victim.orgId)).toEqual(before);
		});

		it("refuses metadata that names another organization without our signature (a forged org), changing nothing", async () => {
			const victim = await platformUser("victim2");
			const payer = await platformUser("payer2");
			const init = await checkout(payer, { planId: "starter", interval: "month", seats: 2, method: "mpesa" });
			const before = { victim: await orgState(victim.orgId), events: await eventCount() };
			const forged = JSON.parse(init.metadata as string) as Record<string, unknown>;
			const event = charge({ ...init, metadata: JSON.stringify({ ...forged, orgId: victim.orgId }) });
			const response = await post(sign(event));
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ code: "BAD_PAYLOAD" });
			expect({ victim: await orgState(victim.orgId), events: await eventCount() }).toEqual(before);
		});

		it("refuses a payment whose amount is not the expected price, and one Paystack does not confirm", async () => {
			const user = await platformUser("amount");
			const init = await checkout(user, { planId: "starter", interval: "month", seats: 2, method: "mpesa" });
			const events = await eventCount();
			for (const event of [
				charge(init, { amount: 100 }),
				charge(init, { verified: { amount: 100 } }),
				charge(init, { verified: { status: "abandoned" } }),
				charge(init, { verified: { currency: "USD" } }),
				charge(init, { extra: { currency: "USD" } }),
			]) {
				const response = await post(sign(event));
				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({ code: "BAD_PAYLOAD" });
			}
			expect(await eventCount()).toBe(events);
			expect((await orgState(user.orgId))?.plan_id).toBe("personal");
		});

		it("answers 500 when Paystack cannot confirm the payment right now, so Paystack retries, and applies it on the retry", async () => {
			const user = await platformUser("retry");
			const event = charge(await checkout(user, { planId: "starter", interval: "month", seats: 2, method: "mpesa" }));
			verifyDown = true;
			try {
				const failed = await post(sign(event));
				expect(failed.status).toBe(500);
				expect(await failed.json()).toEqual({ code: "PROCESSING_ERROR" });
			} finally {
				verifyDown = false;
			}
			expect((await orgState(user.orgId))?.plan_id).toBe("personal");
			expect((await post(sign(event))).status).toBe(200);
			expect((await orgState(user.orgId))?.status).toBe("active");
		});

		it("answers 200 for event types it does not act on, and for charges that are not CareerOS's", async () => {
			const before = await eventCount();
			expect((await post(sign({ event: "invoice.create", data: { id: 1 } }))).status).toBe(200);
			const foreign = await post(
				sign({
					event: "charge.success",
					data: {
						id: 9,
						status: "success",
						reference: "x1",
						amount: 100,
						currency: "KES",
						metadata: { cart: 1 },
						plan: {},
					},
				}),
			);
			expect(foreign.status).toBe(200);
			expect(await foreign.json()).toEqual({ received: true, outcome: "ignored" });
			expect(await eventCount()).toBe(before);
		});

		it("is refused on an organization host", async () => {
			const user = await platformUser("host");
			const event = charge(await checkout(user, { planId: "starter", interval: "month", seats: 2, method: "mpesa" }));
			const [slug] = await ownerRows<{ slug: string }>(`SELECT slug FROM organization WHERE id = $1`, [user.orgId]);
			const before = await eventCount();
			expect((await post(sign(event), `${slug?.slug}.orgs.test`)).status).toBe(404);
			expect(await eventCount()).toBe(before);
			expect((await orgState(user.orgId))?.plan_id).toBe("personal");
		});

		it("answers 404 for a provider that is not the configured one", async () => {
			const response = await hono.request(`${PLATFORM_ORIGIN}/api/billing/webhook/fake`, {
				method: "POST",
				headers: { host: PLATFORM },
				body: "{}",
			});
			expect(response.status).toBe(404);
		});
	});

	describe("the provider plan cache", () => {
		it("is reached only through the definer functions: the app role has no privilege on the table", async () => {
			await expect(app.query(`SELECT * FROM billing_provider_plan`)).rejects.toThrow(/permission denied/);
			await expect(
				app.query(
					`INSERT INTO billing_provider_plan (provider, plan_id, billing_interval, currency, seats, amount, provider_plan_code) VALUES ('paystack','starter','month','KES',1,1,'PLN_x')`,
				),
			).rejects.toThrow(/permission denied/);
		});

		it("creates one Paystack plan per price and reuses it", async () => {
			const user = await platformUser("cache");
			const before = callsTo("POST", "/plan").length;
			const one = await checkout(user, { planId: "starter", interval: "year", seats: 9 });
			const two = await checkout(user, { planId: "starter", interval: "year", seats: 9 });
			expect(two.plan).toBe(one.plan);
			expect(callsTo("POST", "/plan").length).toBe(before + 1);
			const rows = await ownerRows(`SELECT * FROM billing_provider_plan WHERE provider_plan_code = $1`, [one.plan]);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ plan_id: "starter", billing_interval: "year", currency: "KES", seats: 9 });
		});
	});
});
