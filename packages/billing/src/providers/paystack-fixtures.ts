import type { PaystackClient } from "./paystack-client";
import type { PaystackStore, ProviderPlanKey, ProviderPlanRow } from "./paystack-store";
import { PAYSTACK_SIGNATURE_HEADER, paystackSignature, signCheckoutMetadata } from "./paystack";

// CAREEROS (P3-T05): test helpers for the Paystack adapter. The event shapes follow what Paystack's docs show for each
// event type (https://paystack.com/docs/payments/webhooks/ and /payments/subscriptions/, checked 2026-11-08), cut down to
// the fields the adapter reads plus a few it must ignore. No real key, card or customer: every value is made up.
// Used by the unit and integration tests only.

export const TEST_SECRET = "sk_test_unit_test_secret_key_000000";
export const ORG_A = "org_a_0001";
export const ORG_B = "org_b_0001";
export const CUSTOMER = "CUS_testcustomer01";
export const SUBSCRIPTION = "SUB_testsubscr001";
export const PLAN_CODE = "PLN_testplan00001";

export type Signed = { rawBody: Uint8Array; headers: Headers };

export function signPaystack(payload: unknown, secret = TEST_SECRET): Signed {
	const rawBody = new TextEncoder().encode(JSON.stringify(payload));
	return {
		rawBody,
		headers: new Headers({
			"content-type": "application/json",
			[PAYSTACK_SIGNATURE_HEADER]: paystackSignature(secret, rawBody),
		}),
	};
}

export const checkoutMetadata = (
	orgId = ORG_A,
	fields: Partial<{ planId: string; interval: "month" | "year"; seats: number; method: "card" | "mpesa" }> = {},
) =>
	JSON.stringify(
		signCheckoutMetadata(TEST_SECRET, {
			orgId,
			planId: fields.planId ?? "starter",
			interval: fields.interval ?? "month",
			seats: fields.seats ?? 10,
			method: fields.method ?? "card",
		}),
	);

export const chargeSuccess = (overrides: Record<string, unknown> = {}) => ({
	event: "charge.success",
	data: {
		id: 302961,
		domain: "test",
		status: "success",
		reference: "ref_card_0001",
		amount: 490_000,
		currency: "KES",
		channel: "card",
		paid_at: "2026-11-09T08:00:00.000Z",
		customer: { id: 84312, customer_code: CUSTOMER, email: "owner@example.test" },
		authorization: { authorization_code: "AUTH_testauth01", reusable: true, last4: "4081" },
		plan: { name: "CareerOS", plan_code: PLAN_CODE, interval: "monthly", amount: 490_000, currency: "KES" },
		metadata: checkoutMetadata(),
		...overrides,
	},
});

export const subscriptionCreate = (overrides: Record<string, unknown> = {}) => ({
	event: "subscription.create",
	data: {
		domain: "test",
		status: "active",
		subscription_code: SUBSCRIPTION,
		amount: 490_000,
		next_payment_date: "2026-12-09T08:00:00.000Z",
		plan: { name: "CareerOS", plan_code: PLAN_CODE, interval: "monthly", amount: 490_000, currency: "KES" },
		customer: { customer_code: CUSTOMER, email: "owner@example.test" },
		...overrides,
	},
});

export const invoiceFailed = (overrides: Record<string, unknown> = {}) => ({
	event: "invoice.payment_failed",
	data: {
		domain: "test",
		invoice_code: "INV_testinvoice01",
		amount: 490_000,
		status: "failed",
		paid: false,
		subscription: { status: "attention", subscription_code: SUBSCRIPTION, next_payment_date: null },
		customer: { customer_code: CUSTOMER, email: "owner@example.test" },
		...overrides,
	},
});

export const subscriptionEnding = (event: "subscription.not_renew" | "subscription.disable", code = SUBSCRIPTION) => ({
	event,
	data: {
		domain: "test",
		status: event === "subscription.disable" ? "complete" : "non-renewing",
		subscription_code: code,
		customer: { customer_code: CUSTOMER },
		plan: { plan_code: PLAN_CODE },
	},
});

export const verifyData = (overrides: Record<string, unknown> = {}) => ({
	id: 302961,
	status: "success",
	reference: "ref_card_0001",
	amount: 490_000,
	currency: "KES",
	...overrides,
});

export type Call = { method: "GET" | "POST"; path: string; body?: Record<string, unknown> };

/** A scripted Paystack client: answers by `METHOD path` (a function or a value), records every call. */
export function fakeClient(
	answers: Record<string, unknown | ((call: Call) => unknown)>,
): PaystackClient & { calls: Call[] } {
	const calls: Call[] = [];
	const answer = async (method: "GET" | "POST", path: string, body?: Record<string, unknown>) => {
		await Promise.resolve();
		const call: Call = { method, path, ...(body && { body }) };
		calls.push(call);
		const entry = answers[`${method} ${path}`];
		if (entry === undefined) throw new Error(`unexpected Paystack call ${method} ${path}`);
		const value = typeof entry === "function" ? (entry as (c: Call) => unknown)(call) : entry;
		if (value instanceof Error) throw value;
		return value;
	};
	return {
		calls,
		get: ((path: string) => answer("GET", path)) as PaystackClient["get"],
		post: ((path: string, body: Record<string, unknown>) => answer("POST", path, body)) as PaystackClient["post"],
	};
}

/** An in-memory store: provider plans by key, organizations by code. */
export function memoryStore(
	options: { orgs?: Record<string, string>; periodEnd?: Date | null; plans?: Record<string, ProviderPlanRow> } = {},
): PaystackStore & { plans: Map<string, ProviderPlanRow> } {
	const byKey = new Map<string, string>();
	const plans = new Map<string, ProviderPlanRow>(Object.entries(options.plans ?? {}));
	const keyOf = (k: ProviderPlanKey) => [k.planId, k.interval, k.currency, k.seats, k.amount].join("|");
	return {
		plans,
		getPlanCode: (key) => Promise.resolve(byKey.get(keyOf(key)) ?? null),
		putPlanCode: (key, code) => {
			if (!byKey.has(keyOf(key))) {
				byKey.set(keyOf(key), code);
				plans.set(code, { ...key });
			}
			return Promise.resolve(byKey.get(keyOf(key)) ?? code);
		},
		planByCode: (code) => Promise.resolve(plans.get(code) ?? null),
		resolveOrg: (ref) =>
			Promise.resolve(
				(ref.subscriptionCode && options.orgs?.[ref.subscriptionCode]) ||
					(ref.customerCode && options.orgs?.[ref.customerCode]) ||
					null,
			),
		currentPeriodEnd: () => Promise.resolve(options.periodEnd ?? null),
	};
}

export const STARTER_PLAN_ROW: ProviderPlanRow = {
	planId: "starter",
	interval: "month",
	currency: "KES",
	seats: 10,
	amount: 490_000,
};
