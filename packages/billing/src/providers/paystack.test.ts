import type { PlanPrices } from "../pricing";
import { describe, expect, it, vi } from "vite-plus/test";
import { WebhookIgnored, WebhookPayloadError, WebhookRetry, WebhookSignatureError } from "../events";
import {
	addInterval,
	createPaystackProvider,
	PAYSTACK_SIGNATURE_HEADER,
	paystackSignature,
	readCheckoutMetadata,
	signCheckoutMetadata,
} from "./paystack";
import { PaystackError } from "./paystack-client";
import {
	CUSTOMER,
	chargeSuccess,
	checkoutMetadata,
	fakeClient,
	invoiceFailed,
	memoryStore,
	ORG_A,
	ORG_B,
	PLAN_CODE,
	signPaystack,
	STARTER_PLAN_ROW,
	SUBSCRIPTION,
	subscriptionCreate,
	subscriptionEnding,
	TEST_SECRET,
	verifyData,
} from "./paystack-fixtures";
import { ProviderUnsupportedError } from "./types";

const NOW = new Date("2026-11-09T09:00:00.000Z");

// Per seat, KES whole shillings 490 a month -> 49,000 subunits per seat; 10 seats = 490,000.
const starter: PlanPrices = {
	id: "starter",
	pricingModel: "per_seat",
	seatLimit: null,
	active: true,
	priceMonthlyUsdCents: 400,
	priceAnnualUsdCents: 4000,
	priceMonthlyKes: 490,
	priceAnnualKes: 4900,
};
const loadPlan = async (id: string) => (id === "starter" ? starter : null);

function build(
	options: { client?: ReturnType<typeof fakeClient>; store?: ReturnType<typeof memoryStore>; applyEvent?: never } = {},
) {
	const client = options.client ?? fakeClient({});
	const store =
		options.store ??
		memoryStore({ orgs: { [CUSTOMER]: ORG_A, [SUBSCRIPTION]: ORG_A }, plans: { [PLAN_CODE]: STARTER_PLAN_ROW } });
	const provider = createPaystackProvider({ secretKey: TEST_SECRET, client, store, loadPlan, now: () => NOW });
	return { provider, client, store };
}

const verifyOk = (reference = "ref_card_0001", amount = 490_000) => ({
	"GET /transaction/verify/ref_card_0001": verifyData({ reference, amount }),
});

describe("signature", () => {
	const body = new TextEncoder().encode(JSON.stringify(chargeSuccess()));

	it("accepts a body signed with HMAC SHA512 under the secret key", async () => {
		const { provider } = build({ client: fakeClient(verifyOk()) });
		const signed = signPaystack(chargeSuccess());
		const event = await provider.verifyWebhook(signed.rawBody, signed.headers);
		expect(event.type).toBe("checkout.completed");
	});

	it("matches Paystack's documented algorithm (HMAC SHA512, hex, of the raw body)", () => {
		// Computed independently: printf '{}' | openssl dgst -sha512 -hmac key
		expect(paystackSignature("key", new TextEncoder().encode("{}"))).toBe(
			"55fabdaa182c70ee206b1214d44e350c994779dfc34241b286dc6d3f12a2cd70f6b9e57f19d661a86d8486048744ba18c0fe8f821783075f9089b585e5edd729",
		);
		expect(paystackSignature("key", body)).toMatch(/^[0-9a-f]{128}$/);
	});

	it("refuses a tampered body", async () => {
		const { provider } = build();
		const signed = signPaystack(chargeSuccess());
		const tampered = new TextEncoder().encode(new TextDecoder().decode(signed.rawBody).replace("490000", "1"));
		await expect(provider.verifyWebhook(tampered, signed.headers)).rejects.toBeInstanceOf(WebhookSignatureError);
	});

	it("refuses a signature made with another key", async () => {
		const { provider } = build();
		const signed = signPaystack(chargeSuccess(), "sk_test_some_other_key_0000000000");
		await expect(provider.verifyWebhook(signed.rawBody, signed.headers)).rejects.toBeInstanceOf(WebhookSignatureError);
	});

	it("refuses a missing or malformed header", async () => {
		const { provider } = build();
		const signed = signPaystack(chargeSuccess());
		await expect(provider.verifyWebhook(signed.rawBody, new Headers())).rejects.toBeInstanceOf(WebhookSignatureError);
		for (const value of ["", "abc", "z".repeat(128), `${"a".repeat(127)}`, `${"a".repeat(129)}`])
			await expect(
				provider.verifyWebhook(signed.rawBody, new Headers({ [PAYSTACK_SIGNATURE_HEADER]: value })),
			).rejects.toBeInstanceOf(WebhookSignatureError);
	});

	it("accepts an upper-case hex signature (the compare is on the decoded bytes)", async () => {
		const { provider } = build({ client: fakeClient(verifyOk()) });
		const signed = signPaystack(chargeSuccess());
		const upper = new Headers({
			[PAYSTACK_SIGNATURE_HEADER]: (signed.headers.get(PAYSTACK_SIGNATURE_HEADER) ?? "").toUpperCase(),
		});
		await expect(provider.verifyWebhook(signed.rawBody, upper)).resolves.toMatchObject({ orgId: ORG_A });
	});

	it("uses a constant-time compare and reads nothing before it passes", async () => {
		const source = await import("node:fs").then((fs) =>
			fs.readFileSync(new URL("./paystack.ts", import.meta.url), "utf8"),
		);
		expect(source).toContain("timingSafeEqual(expected, received)");
		// No JSON.parse is reachable ahead of checkSignature in verifyWebhook.
		const verify = source.slice(source.indexOf("async verifyWebhook"));
		expect(verify.indexOf("checkSignature(")).toBeLessThan(verify.indexOf("JSON.parse"));
	});

	it("never calls Paystack for an unsigned body", async () => {
		const client = fakeClient({});
		const { provider } = build({ client });
		const signed = signPaystack(chargeSuccess(), "wrong");
		await expect(provider.verifyWebhook(signed.rawBody, signed.headers)).rejects.toBeInstanceOf(WebhookSignatureError);
		expect(client.calls).toEqual([]);
	});
});

describe("checkout metadata", () => {
	const fields = { orgId: ORG_A, planId: "starter", interval: "month", seats: 10, method: "card" } as const;

	it("round-trips a signed metadata object (as an object or a string)", () => {
		const signed = signCheckoutMetadata(TEST_SECRET, fields);
		expect(readCheckoutMetadata(TEST_SECRET, signed)).toMatchObject(fields);
		expect(readCheckoutMetadata(TEST_SECRET, JSON.stringify(signed))).toMatchObject(fields);
	});

	it("gives every checkout its own nonce", () => {
		const a = signCheckoutMetadata(TEST_SECRET, fields);
		const b = signCheckoutMetadata(TEST_SECRET, fields);
		expect(a.nonce).not.toBe(b.nonce);
		expect(a.sig).not.toBe(b.sig);
	});

	it("treats metadata that is not ours as absent", () => {
		for (const raw of [undefined, null, "", "  ", "not json", {}, { referrer: "x" }, [], 5])
			expect(readCheckoutMetadata(TEST_SECRET, raw)).toBeNull();
	});

	it("refuses a forged organization id (the signature no longer matches)", () => {
		const signed = signCheckoutMetadata(TEST_SECRET, fields);
		expect(() => readCheckoutMetadata(TEST_SECRET, { ...signed, orgId: ORG_B })).toThrow(WebhookPayloadError);
	});

	it("refuses changed seats, plan, interval or method", () => {
		const signed = signCheckoutMetadata(TEST_SECRET, fields);
		for (const change of [{ seats: 1 }, { planId: "pro" }, { interval: "year" }, { method: "mpesa" }])
			expect(() => readCheckoutMetadata(TEST_SECRET, { ...signed, ...change })).toThrow(WebhookPayloadError);
	});

	it("refuses an organization id with no signature, a bad nonce and metadata signed with another key", () => {
		const signed = signCheckoutMetadata(TEST_SECRET, fields);
		expect(() => readCheckoutMetadata(TEST_SECRET, { orgId: ORG_B })).toThrow(WebhookPayloadError);
		expect(() => readCheckoutMetadata(TEST_SECRET, { ...signed, nonce: "zz" })).toThrow(WebhookPayloadError);
		expect(() => readCheckoutMetadata("sk_test_other_secret_key_00000000", signed)).toThrow(WebhookPayloadError);
	});
});

describe("event mapping", () => {
	const verify = (payload: unknown, options: Parameters<typeof build>[0] = {}) => {
		const built = build(options);
		const signed = signPaystack(payload);
		return { ...built, run: () => built.provider.verifyWebhook(signed.rawBody, signed.headers) };
	};

	it("charge.success with signed metadata is checkout.completed, priced from the plan and confirmed with Paystack", async () => {
		const { run, client } = verify(chargeSuccess(), { client: fakeClient(verifyOk()) });
		const event = await run();
		expect(event).toMatchObject({
			type: "checkout.completed",
			provider: "paystack",
			providerEventId: "charge.success:302961",
			orgId: ORG_A,
			planId: "starter",
			seats: 10,
			interval: "month",
			amount: 490_000,
			currency: "KES",
			providerCustomerId: CUSTOMER,
		});
		expect(event.periodStart?.toISOString()).toBe("2026-11-09T08:00:00.000Z");
		expect(event.periodEnd?.toISOString()).toBe("2026-12-09T08:00:00.000Z");
		expect(client.calls).toEqual([{ method: "GET", path: "/transaction/verify/ref_card_0001" }]);
	});

	it("a renewal charge (no metadata) is payment.succeeded for the organization the customer code names", async () => {
		const { run } = verify(chargeSuccess({ metadata: "" }), { client: fakeClient(verifyOk()) });
		await expect(run()).resolves.toMatchObject({
			type: "payment.succeeded",
			orgId: ORG_A,
			seats: 10,
			planId: "starter",
		});
	});

	it("an annual plan runs a year", async () => {
		const yearRow = { ...STARTER_PLAN_ROW, interval: "year" as const, amount: 4_900_00 * 1 };
		const store = memoryStore({ orgs: { [CUSTOMER]: ORG_A }, plans: { [PLAN_CODE]: yearRow } });
		const { run } = verify(chargeSuccess({ metadata: "", amount: yearRow.amount }), {
			store,
			client: fakeClient({ "GET /transaction/verify/ref_card_0001": verifyData({ amount: yearRow.amount }) }),
		});
		const event = await run();
		expect(event.periodEnd?.toISOString()).toBe("2027-11-09T08:00:00.000Z");
	});

	it("an M-Pesa charge (no plan) is priced from the plan table and paid early extends from the held period end", async () => {
		const held = new Date("2026-11-12T00:00:00.000Z");
		const metadata = checkoutMetadata(ORG_A, { method: "mpesa" });
		const { run } = verify(chargeSuccess({ plan: {}, metadata, channel: "mobile_money" }), {
			store: memoryStore({ periodEnd: held }),
			client: fakeClient(verifyOk()),
		});
		const event = await run();
		expect(event.type).toBe("checkout.completed");
		expect(event.periodStart?.toISOString()).toBe(held.toISOString());
		expect(event.periodEnd?.toISOString()).toBe("2026-12-12T00:00:00.000Z");
		expect(event.providerSubscriptionId ?? null).toBeNull();
	});

	it("an M-Pesa charge after the period ended starts at the payment", async () => {
		const metadata = checkoutMetadata(ORG_A, { method: "mpesa" });
		const { run } = verify(chargeSuccess({ plan: null, metadata }), {
			store: memoryStore({ periodEnd: new Date("2026-10-01T00:00:00.000Z") }),
			client: fakeClient(verifyOk()),
		});
		expect((await run()).periodStart?.toISOString()).toBe("2026-11-09T08:00:00.000Z");
	});

	it("subscription.create is subscription.updated that only records the provider ids", async () => {
		const { run } = verify(subscriptionCreate({ id: 5551 }));
		const event = await run();
		expect(event).toMatchObject({
			type: "subscription.updated",
			providerEventId: "subscription.create:5551",
			orgId: ORG_A,
			providerSubscriptionId: SUBSCRIPTION,
			providerCustomerId: CUSTOMER,
			planId: null,
			seats: null,
			interval: null,
			periodEnd: null,
		});
	});

	it("invoice.payment_failed is payment.failed", async () => {
		const { run } = verify(invoiceFailed());
		await expect(run()).resolves.toMatchObject({
			type: "payment.failed",
			providerEventId: "invoice.payment_failed:INV_testinvoice01",
			orgId: ORG_A,
			amount: 490_000,
		});
	});

	it.each(["subscription.not_renew", "subscription.disable"] as const)(
		"%s is subscription.canceled with no period end",
		async (name) => {
			const { run } = verify(subscriptionEnding(name));
			await expect(run()).resolves.toMatchObject({
				type: "subscription.canceled",
				providerEventId: `${name}:${SUBSCRIPTION}`,
				orgId: ORG_A,
				providerSubscriptionId: SUBSCRIPTION,
				periodEnd: null,
			});
		},
	);

	it("every other signed event type is ignored", async () => {
		for (const event of [
			"invoice.create",
			"invoice.update",
			"charge.failed",
			"transfer.success",
			"subscription.expiring_cards",
			"customeridentification.failed",
		])
			await expect(verify({ event, data: { id: 1 } }).run()).rejects.toBeInstanceOf(WebhookIgnored);
	});

	it("ignores a charge that is not ours (no signed metadata and no plan we created)", async () => {
		await expect(verify(chargeSuccess({ metadata: {}, plan: {} })).run()).rejects.toBeInstanceOf(WebhookIgnored);
		await expect(
			verify(chargeSuccess({ metadata: { referrer: "shop" }, plan: { plan_code: "PLN_other" } })).run(),
		).rejects.toBeInstanceOf(WebhookIgnored);
	});

	it("ignores a charge that was not a success", async () => {
		await expect(verify(chargeSuccess({ status: "failed" })).run()).rejects.toBeInstanceOf(WebhookIgnored);
	});

	it("refuses a signed body that is not an event", async () => {
		for (const payload of [[], "x", { event: 5 }, { event: "charge.success" }, { event: "charge.success", data: [] }])
			await expect(verify(payload).run()).rejects.toBeInstanceOf(WebhookPayloadError);
	});

	it("refuses an unsigned organization id in the metadata (a forgery) before calling Paystack", async () => {
		const client = fakeClient({});
		const { run } = verify(chargeSuccess({ metadata: JSON.stringify({ orgId: ORG_B }) }), { client });
		await expect(run()).rejects.toBeInstanceOf(WebhookPayloadError);
		expect(client.calls).toEqual([]);
	});

	it("takes the organization from the signed metadata and nothing else in the payload", async () => {
		const { run } = verify(
			chargeSuccess({
				organization_id: ORG_B,
				orgId: ORG_B,
				customer: { customer_code: CUSTOMER, email: "x@example.test", metadata: { orgId: ORG_B } },
				custom_fields: [{ variable_name: "orgId", value: ORG_B }],
			}),
			{ client: fakeClient(verifyOk()) },
		);
		await expect(run()).resolves.toMatchObject({ orgId: ORG_A });
	});

	it("asks Paystack to retry later when a subscription event names a customer with no organization yet", async () => {
		const empty = memoryStore({ plans: { [PLAN_CODE]: STARTER_PLAN_ROW } });
		await expect(verify(subscriptionCreate(), { store: empty }).run()).rejects.toBeInstanceOf(WebhookRetry);
		await expect(verify(invoiceFailed(), { store: empty }).run()).rejects.toBeInstanceOf(WebhookRetry);
		await expect(verify(chargeSuccess({ metadata: "" }), { store: empty }).run()).rejects.toBeInstanceOf(WebhookRetry);
	});

	it("ignores the cancellation of a subscription that is not known", async () => {
		const empty = memoryStore();
		await expect(verify(subscriptionEnding("subscription.disable"), { store: empty }).run()).rejects.toBeInstanceOf(
			WebhookIgnored,
		);
	});
});

describe("amount and currency verification", () => {
	const run = (payload: unknown, verifyAnswer: unknown) => {
		const client = fakeClient({ "GET /transaction/verify/ref_card_0001": verifyAnswer });
		const { provider } = build({ client });
		const signed = signPaystack(payload);
		return provider.verifyWebhook(signed.rawBody, signed.headers);
	};

	it("refuses a webhook whose amount is not the expected price", async () => {
		await expect(run(chargeSuccess({ amount: 100 }), verifyData({ amount: 100 }))).rejects.toBeInstanceOf(
			WebhookPayloadError,
		);
	});

	it("refuses a webhook in another currency", async () => {
		await expect(run(chargeSuccess({ currency: "USD" }), verifyData({ currency: "USD" }))).rejects.toBeInstanceOf(
			WebhookPayloadError,
		);
	});

	it("refuses when Paystack's own record disagrees with the webhook (amount, currency, status, reference)", async () => {
		for (const verified of [
			verifyData({ amount: 100 }),
			verifyData({ currency: "NGN" }),
			verifyData({ status: "abandoned" }),
			verifyData({ status: "failed" }),
			verifyData({ reference: "someone_elses" }),
			null,
		])
			await expect(run(chargeSuccess(), verified)).rejects.toBeInstanceOf(WebhookPayloadError);
	});

	it("refuses an M-Pesa charge that is not today's price for the plan, interval and seats", async () => {
		const metadata = checkoutMetadata(ORG_A, { method: "mpesa", seats: 3 });
		// 3 seats cost 147,000, not 490,000.
		await expect(run(chargeSuccess({ plan: {}, metadata }), verifyData())).rejects.toBeInstanceOf(WebhookPayloadError);
		await expect(
			run(chargeSuccess({ plan: {}, metadata, amount: 147_000 }), verifyData({ amount: 147_000 })),
		).resolves.toMatchObject({ amount: 147_000, seats: 3 });
	});

	it("refuses metadata whose plan has no KES price, and a plan code that disagrees with the checkout", async () => {
		const noPrice = checkoutMetadata(ORG_A, { planId: "enterprise", method: "mpesa" });
		await expect(run(chargeSuccess({ plan: {}, metadata: noPrice }), verifyData())).rejects.toBeInstanceOf(
			WebhookPayloadError,
		);
		const wrongSeats = checkoutMetadata(ORG_A, { seats: 4 });
		await expect(run(chargeSuccess({ metadata: wrongSeats }), verifyData())).rejects.toBeInstanceOf(
			WebhookPayloadError,
		);
	});

	it("asks for a retry when Paystack cannot be reached, and refuses when Paystack says it has no such payment", async () => {
		await expect(
			run(chargeSuccess(), new PaystackError("Paystack could not be reached.", null)),
		).rejects.toBeInstanceOf(WebhookRetry);
		await expect(run(chargeSuccess(), new PaystackError("busy", 503))).rejects.toBeInstanceOf(WebhookRetry);
		await expect(
			run(chargeSuccess(), new PaystackError("Transaction reference not found", 404)),
		).rejects.toBeInstanceOf(WebhookPayloadError);
	});

	it("refuses a reference that is not a plain token, so it cannot reach another path", async () => {
		const client = fakeClient({});
		const { provider } = build({ client });
		const signed = signPaystack(chargeSuccess({ reference: "../customer" }));
		await expect(provider.verifyWebhook(signed.rawBody, signed.headers)).rejects.toBeInstanceOf(WebhookPayloadError);
		expect(client.calls).toEqual([]);
	});
});

describe("createCheckout", () => {
	const input = {
		orgId: ORG_A,
		planId: "starter",
		interval: "month" as const,
		seats: 10,
		customerEmail: "owner@example.test",
		returnUrl: "https://app.example.test/dashboard",
	};

	it("card: creates a plan for this seat count once, then starts a card-only transaction on it", async () => {
		const client = fakeClient({
			"POST /plan": { plan_code: "PLN_new0000000001" },
			"POST /transaction/initialize": { authorization_url: "https://checkout.paystack.com/abc", reference: "r" },
		});
		const { provider } = build({ client, store: memoryStore() });
		await expect(provider.createCheckout({ ...input, method: "card" })).resolves.toEqual({
			redirectUrl: "https://checkout.paystack.com/abc",
		});
		const [plan, init] = client.calls;
		expect(plan?.body).toMatchObject({ interval: "monthly", amount: 490_000, currency: "KES" });
		expect(init?.body).toMatchObject({
			email: "owner@example.test",
			amount: 490_000,
			currency: "KES",
			channels: ["card"],
			plan: "PLN_new0000000001",
			callback_url: "https://app.example.test/dashboard",
		});
		const metadata = readCheckoutMetadata(TEST_SECRET, init?.body?.metadata);
		expect(metadata).toMatchObject({ orgId: ORG_A, planId: "starter", interval: "month", seats: 10, method: "card" });

		// The second checkout for the same price reuses the cached plan and creates none.
		await provider.createCheckout(input);
		expect(client.calls.filter((c) => c.path === "/plan")).toHaveLength(1);
	});

	it("card: a different seat count or interval is a different Paystack plan", async () => {
		let n = 0;
		const client = fakeClient({
			"POST /plan": () => ({ plan_code: `PLN_plan00000000${++n}` }),
			"POST /transaction/initialize": { authorization_url: "https://checkout.paystack.com/abc" },
		});
		const { provider } = build({ client, store: memoryStore() });
		await provider.createCheckout(input);
		await provider.createCheckout({ ...input, seats: 11 });
		await provider.createCheckout({ ...input, interval: "year" });
		expect(client.calls.filter((c) => c.path === "/plan").map((c) => c.body?.amount)).toEqual([
			490_000,
			539_000,
			4_900_00 * 10,
		]);
	});

	it("mpesa: a one-period mobile-money charge with no plan", async () => {
		const client = fakeClient({
			"POST /transaction/initialize": { authorization_url: "https://checkout.paystack.com/mpesa" },
		});
		const { provider } = build({ client });
		await expect(provider.createCheckout({ ...input, method: "mpesa" })).resolves.toEqual({
			redirectUrl: "https://checkout.paystack.com/mpesa",
		});
		const [init] = client.calls;
		expect(init?.body).toMatchObject({ channels: ["mobile_money"], currency: "KES", amount: 490_000 });
		expect(init?.body).not.toHaveProperty("plan");
		expect(readCheckoutMetadata(TEST_SECRET, init?.body?.metadata)).toMatchObject({ method: "mpesa", orgId: ORG_A });
	});

	it("refuses a plan with no KES price", async () => {
		const { provider } = build();
		await expect(provider.createCheckout({ ...input, planId: "enterprise" })).rejects.toBeInstanceOf(
			ProviderUnsupportedError,
		);
	});

	it("refuses a payment page that is not https", async () => {
		const client = fakeClient({ "POST /transaction/initialize": { authorization_url: "http://evil.example/pay" } });
		const { provider } = build({ client });
		await expect(provider.createCheckout({ ...input, method: "mpesa" })).rejects.toBeInstanceOf(PaystackError);
	});
});

describe("changeSeats, cancel and the portal", () => {
	const details = {
		subscription_code: SUBSCRIPTION,
		email_token: "tok_email_0001",
		status: "active",
		next_payment_date: "2026-12-09T08:00:00.000Z",
		customer: { customer_code: CUSTOMER },
		authorization: { authorization_code: "AUTH_testauth01" },
	};
	const seatInput = { orgId: ORG_A, planId: "starter", interval: "month" as const, seats: 12 };

	it("card: creates the new subscription for the next period, records the pending change, then disables the old one", async () => {
		const order: string[] = [];
		const client = fakeClient({
			[`GET /subscription/${SUBSCRIPTION}`]: details,
			"POST /plan": { plan_code: "PLN_seats12plan001" },
			"POST /subscription": () => {
				order.push("create");
				return { subscription_code: "SUB_replacement01" };
			},
			"POST /subscription/disable": () => {
				order.push("disable");
				return {};
			},
		});
		const { provider } = build({ client, store: memoryStore() });
		const onPending = vi.fn(async () => {
			order.push("pending");
		});
		await provider.changeSeats({ ...seatInput, providerSubscriptionId: SUBSCRIPTION, onPending });
		expect(order).toEqual(["create", "pending", "disable"]);
		expect(onPending).toHaveBeenCalledWith({ seats: 12, replacesSubscriptionId: SUBSCRIPTION });
		const create = client.calls.find((c) => c.path === "/subscription");
		expect(create?.body).toEqual({
			customer: CUSTOMER,
			plan: "PLN_seats12plan001",
			authorization: "AUTH_testauth01",
			start_date: "2026-12-09T08:00:00.000Z",
		});
		expect(client.calls.find((c) => c.path === "/subscription/disable")?.body).toEqual({
			code: SUBSCRIPTION,
			token: "tok_email_0001",
		});
	});

	it("card: when disabling the old subscription fails the new one is taken down again and the error is raised", async () => {
		const client = fakeClient({
			[`GET /subscription/${SUBSCRIPTION}`]: details,
			"GET /subscription/SUB_replacement01": {
				...details,
				subscription_code: "SUB_replacement01",
				email_token: "tok_new",
			},
			"POST /plan": { plan_code: "PLN_seats12plan001" },
			"POST /subscription": { subscription_code: "SUB_replacement01" },
			"POST /subscription/disable": (call: { body?: Record<string, unknown> }) =>
				call.body?.code === SUBSCRIPTION ? new PaystackError("busy", 503) : {},
		});
		const { provider } = build({ client, store: memoryStore() });
		await expect(provider.changeSeats({ ...seatInput, providerSubscriptionId: SUBSCRIPTION })).rejects.toBeInstanceOf(
			PaystackError,
		);
		expect(client.calls.filter((c) => c.path === "/subscription/disable").map((c) => c.body?.code)).toEqual([
			SUBSCRIPTION,
			"SUB_replacement01",
		]);
	});

	it("card: changes nothing at Paystack when the new subscription cannot be created", async () => {
		const client = fakeClient({
			[`GET /subscription/${SUBSCRIPTION}`]: details,
			"POST /plan": { plan_code: "PLN_seats12plan001" },
			"POST /subscription": new PaystackError("no", 400),
		});
		const { provider } = build({ client, store: memoryStore() });
		const onPending = vi.fn();
		await expect(
			provider.changeSeats({ ...seatInput, providerSubscriptionId: SUBSCRIPTION, onPending }),
		).rejects.toBeInstanceOf(PaystackError);
		expect(onPending).not.toHaveBeenCalled();
		expect(client.calls.some((c) => c.path === "/subscription/disable")).toBe(false);
	});

	it("mpesa: asks nothing of Paystack; the next payment is made for the new count", async () => {
		const client = fakeClient({});
		const { provider } = build({ client });
		const onPending = vi.fn(async () => undefined);
		await provider.changeSeats({ ...seatInput, providerSubscriptionId: null, onPending });
		expect(onPending).toHaveBeenCalledWith({ seats: 12, replacesSubscriptionId: null });
		expect(client.calls).toEqual([]);
	});

	it("card cancel: disables the subscription with its email token", async () => {
		const client = fakeClient({ [`GET /subscription/${SUBSCRIPTION}`]: details, "POST /subscription/disable": {} });
		const { provider } = build({ client });
		await provider.cancel({ orgId: ORG_A, providerSubscriptionId: SUBSCRIPTION, periodEnd: null });
		expect(client.calls.at(-1)).toEqual({
			method: "POST",
			path: "/subscription/disable",
			body: { code: SUBSCRIPTION, token: "tok_email_0001" },
		});
	});

	it("mpesa cancel: no Paystack call, CareerOS records the cancellation itself", async () => {
		const client = fakeClient({});
		const applyEvent = vi.fn(async () => undefined);
		const provider = createPaystackProvider({
			secretKey: TEST_SECRET,
			client,
			store: memoryStore(),
			loadPlan,
			applyEvent,
			now: () => NOW,
		});
		await provider.cancel({ orgId: ORG_A, providerSubscriptionId: null, periodEnd: null });
		expect(client.calls).toEqual([]);
		expect(applyEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "subscription.canceled", orgId: ORG_A, provider: "paystack" }),
		);
	});

	it("portal: the manage link for a card subscription, null for M-Pesa", async () => {
		const client = fakeClient({
			[`GET /subscription/${SUBSCRIPTION}/manage/link`]: { link: "https://paystack.com/manage/abc" },
		});
		const { provider } = build({ client });
		const base = { orgId: ORG_A, providerCustomerId: CUSTOMER, returnUrl: "https://app.example.test/" };
		await expect(provider.customerPortalUrl({ ...base, providerSubscriptionId: SUBSCRIPTION })).resolves.toBe(
			"https://paystack.com/manage/abc",
		);
		await expect(provider.customerPortalUrl({ ...base, providerSubscriptionId: null })).resolves.toBeNull();
		expect(client.calls).toHaveLength(1);
	});
});

describe("addInterval", () => {
	it("keeps the day of the month and clamps to a shorter month", () => {
		expect(addInterval(new Date("2026-01-31T10:00:00Z"), "month").toISOString()).toBe("2026-02-28T10:00:00.000Z");
		expect(addInterval(new Date("2026-11-09T08:00:00Z"), "month").toISOString()).toBe("2026-12-09T08:00:00.000Z");
		expect(addInterval(new Date("2026-12-15T08:00:00Z"), "month").toISOString()).toBe("2027-01-15T08:00:00.000Z");
		expect(addInterval(new Date("2028-02-29T08:00:00Z"), "year").toISOString()).toBe("2029-02-28T08:00:00.000Z");
	});
});
