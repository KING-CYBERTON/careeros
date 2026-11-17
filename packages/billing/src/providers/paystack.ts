import type { BillingEvent } from "../events";
import type { PlanPrices } from "../pricing";
import type { PaystackClient } from "./paystack-client";
import type { PaystackStore, ProviderPlanKey } from "./paystack-store";
import type { BillingInterval } from "@reactive-resume/db/schema";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebhookIgnored, WebhookPayloadError, WebhookRetry, WebhookSignatureError } from "../events";
import { applyBillingEvent } from "../intake";
import { loadPlanPrices } from "../plans";
import { priceFor } from "../pricing";
import { createPaystackClient, PaystackError } from "./paystack-client";
import { databasePaystackStore } from "./paystack-store";
import {
	type BillingProvider,
	type CancelInput,
	type ChangeSeatsInput,
	type CheckoutInput,
	type CheckoutResult,
	type PortalInput,
	ProviderUnsupportedError,
} from "./types";

// CAREEROS (P3-T05, phase plan D1, D9): the Paystack adapter. Facts it relies on come from Paystack's docs as of
// 2026-11-08 (see the PR body for the pages): Kenya takes card and mobile money (M-Pesa) in KES, in the subunit (cents);
// subscriptions are card only; a webhook carries `x-paystack-signature`, the HMAC SHA512 of the raw body under the secret
// key; a plan has a fixed amount and no quantity, and a transaction started with a plan ignores its own amount.
//
// The security properties, in order:
//   1. the signature is checked over the RAW bytes with a constant-time compare before anything is parsed;
//   2. the organization comes only from the event's metadata, which CareerOS signed when it started the checkout (a
//      nonce plus an HMAC over the org, plan, interval, seats and method under a key derived from the secret key), or,
//      for events with no metadata (renewals, subscription events), from the provider ids saved on the first payment;
//      never from the host, a header or any other field;
//   3. a payment is only believed after Paystack itself confirms it: `GET /transaction/verify/:reference` must show a
//      successful transaction in the expected currency for exactly the expected amount.

export const PAYSTACK_SIGNATURE_HEADER = "x-paystack-signature";
export const PAYSTACK_CURRENCY = "KES";

const INTERVALS: Record<BillingInterval, "monthly" | "annually"> = { month: "monthly", year: "annually" };
const MAX_SEATS = 10_000;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/;
const REFERENCE = /^[A-Za-z0-9._=-]{1,100}$/;
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PLAN_ID = /^[a-z][a-z0-9_-]{0,63}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// --- Signature -----------------------------------------------------------------------------------------------------

/** The signature Paystack sends for a body. Exported for tests and fixtures. */
export const paystackSignature = (secretKey: string, rawBody: Uint8Array) =>
	createHmac("sha512", secretKey).update(rawBody).digest("hex");

function checkSignature(secretKey: string, rawBody: Uint8Array, headers: Headers) {
	const given = headers.get(PAYSTACK_SIGNATURE_HEADER)?.trim().toLowerCase();
	if (!given || !SIGNATURE_HEX.test(given)) throw new WebhookSignatureError();
	const expected = Buffer.from(paystackSignature(secretKey, rawBody), "hex");
	const received = Buffer.from(given, "hex");
	if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new WebhookSignatureError();
}

// --- Checkout metadata ---------------------------------------------------------------------------------------------

export type CheckoutMetadata = {
	orgId: string;
	planId: string;
	interval: BillingInterval;
	seats: number;
	method: "card" | "mpesa";
	nonce: string;
};

/** A key for the metadata signature that is not the webhook key itself. */
const metadataKey = (secretKey: string) =>
	createHmac("sha256", secretKey).update("careeros.paystack.metadata.v1").digest();

const metadataSignature = (secretKey: string, m: CheckoutMetadata) =>
	createHmac("sha256", metadataKey(secretKey))
		.update([m.orgId, m.planId, m.interval, m.seats, m.method, m.nonce].join("|"))
		.digest("hex");

/** The metadata object to send to Paystack (stringified by the caller): the fields, a fresh nonce, and the signature. */
export function signCheckoutMetadata(
	secretKey: string,
	fields: Omit<CheckoutMetadata, "nonce">,
): Record<string, unknown> {
	const metadata: CheckoutMetadata = { ...fields, nonce: randomBytes(12).toString("hex") };
	return { ...metadata, sig: metadataSignature(secretKey, metadata) };
}

/**
 * The checked metadata of an event, or null when the event carries none of ours (a renewal, or a payment that is not
 * CareerOS's). Metadata that claims to be ours (names an organization or carries a signature) but does not check out is
 * a forgery: it throws, so a forged organization id never reaches the intake.
 */
export function readCheckoutMetadata(secretKey: string, raw: unknown): CheckoutMetadata | null {
	let value = raw;
	if (typeof value === "string") {
		if (!value.trim()) return null;
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (!isRecord(value) || (value.orgId === undefined && value.sig === undefined)) return null;
	const { orgId, planId, interval, seats, method, nonce, sig } = value;
	if (
		typeof orgId !== "string" ||
		!ORG_ID.test(orgId) ||
		typeof planId !== "string" ||
		!PLAN_ID.test(planId) ||
		(interval !== "month" && interval !== "year") ||
		typeof seats !== "number" ||
		!Number.isInteger(seats) ||
		seats < 1 ||
		seats > MAX_SEATS ||
		(method !== "card" && method !== "mpesa") ||
		typeof nonce !== "string" ||
		!/^[0-9a-f]{24}$/.test(nonce) ||
		typeof sig !== "string" ||
		!/^[0-9a-f]{64}$/.test(sig)
	)
		throw new WebhookPayloadError("The webhook metadata is not valid.");
	const metadata: CheckoutMetadata = { orgId, planId, interval, seats, method, nonce };
	const expected = Buffer.from(metadataSignature(secretKey, metadata), "hex");
	const received = Buffer.from(sig, "hex");
	if (expected.length !== received.length || !timingSafeEqual(expected, received))
		throw new WebhookPayloadError("The webhook metadata is not signed by this server.");
	return metadata;
}

// --- Small readers -------------------------------------------------------------------------------------------------

const text = (value: unknown, pattern: RegExp): string | null =>
	typeof value === "string" && pattern.test(value) ? value : null;

const wholeNumber = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function dateOf(value: unknown): Date | null {
	if (typeof value !== "string") return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** One month or year on, keeping the day of the month where the month has it (31 January + 1 month = 28 February). */
export function addInterval(from: Date, interval: BillingInterval): Date {
	const to = new Date(from);
	const day = to.getUTCDate();
	to.setUTCDate(1);
	if (interval === "year") to.setUTCFullYear(to.getUTCFullYear() + 1);
	else to.setUTCMonth(to.getUTCMonth() + 1);
	const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate();
	to.setUTCDate(Math.min(day, last));
	return to;
}

function eventId(type: string, id: unknown): string {
	const part = typeof id === "number" || typeof id === "string" ? String(id) : "";
	const value = `${type}:${part}`;
	if (!part || !EVENT_ID.test(value)) throw new WebhookPayloadError("The webhook event has no usable id.");
	return value;
}

/** The nested `plan.plan_code` of a payload; null for `plan: {}`, null or a missing plan. */
const planCodeOf = (data: Record<string, unknown>) => (isRecord(data.plan) ? text(data.plan.plan_code, CODE) : null);
const customerCodeOf = (data: Record<string, unknown>) =>
	isRecord(data.customer) ? text(data.customer.customer_code, CODE) : null;

// --- The provider --------------------------------------------------------------------------------------------------

export type PaystackProviderOptions = {
	secretKey: string;
	publicKey?: string | undefined;
	client?: PaystackClient;
	fetch?: typeof fetch;
	store?: PaystackStore;
	loadPlan?: (planId: string) => Promise<PlanPrices | null>;
	/** Applies an event CareerOS itself raised (an M-Pesa cancellation). Defaults to the webhook intake. */
	applyEvent?: (event: BillingEvent) => Promise<unknown>;
	now?: () => Date;
};

type SubscriptionDetails = {
	subscription_code?: unknown;
	email_token?: unknown;
	next_payment_date?: unknown;
	status?: unknown;
	customer?: unknown;
	authorization?: unknown;
};

export function createPaystackProvider(options: PaystackProviderOptions): BillingProvider {
	const secretKey = options.secretKey;
	const client = options.client ?? createPaystackClient({ secretKey, ...(options.fetch && { fetch: options.fetch }) });
	const store = options.store ?? databasePaystackStore;
	const loadPlan = options.loadPlan ?? loadPlanPrices;
	const applyEvent = options.applyEvent ?? ((event: BillingEvent) => applyBillingEvent(event));
	const now = options.now ?? (() => new Date());

	/** The KES price of `seats` seats, or the refusal that an organization without a KES price cannot buy online. */
	async function priceOf(planId: string, interval: BillingInterval, seats: number) {
		const plan = await loadPlan(planId);
		const amount = plan ? priceFor(plan, interval, seats, PAYSTACK_CURRENCY) : null;
		if (!plan || amount === null) throw new ProviderUnsupportedError("paystack", `selling ${planId} in KES`);
		return amount;
	}

	/** The Paystack plan for this price, created on first use (a plan has one fixed amount, so seats are part of the key). */
	async function planCodeFor(key: ProviderPlanKey): Promise<string> {
		const cached = await store.getPlanCode(key);
		if (cached) return cached;
		const created = await client.post<{ plan_code?: unknown }>("/plan", {
			name: `CareerOS ${key.planId} ${key.interval}ly, ${key.seats} seat${key.seats === 1 ? "" : "s"}, ${key.amount / 100} ${key.currency}`,
			interval: INTERVALS[key.interval],
			amount: key.amount,
			currency: key.currency,
		});
		const code = text(created.plan_code, CODE);
		if (!code) throw new PaystackError("Paystack did not return a plan code.", null);
		return await store.putPlanCode(key, code);
	}

	async function initialize(
		input: CheckoutInput,
		method: "card" | "mpesa",
		amount: number,
		plan: string | null,
	): Promise<CheckoutResult> {
		const metadata = signCheckoutMetadata(secretKey, {
			orgId: input.orgId,
			planId: input.planId,
			interval: input.interval,
			seats: input.seats,
			method,
		});
		const data = await client.post<{ authorization_url?: unknown }>("/transaction/initialize", {
			email: input.customerEmail,
			// With a plan Paystack charges the plan's amount; it is sent anyway because the field is required.
			amount,
			currency: PAYSTACK_CURRENCY,
			channels: method === "card" ? ["card"] : ["mobile_money"],
			callback_url: input.returnUrl,
			metadata: JSON.stringify(metadata),
			...(plan && { plan }),
		});
		const url = typeof data.authorization_url === "string" ? data.authorization_url : "";
		if (!url.startsWith("https://")) throw new PaystackError("Paystack did not return a payment page.", null);
		return { redirectUrl: url };
	}

	async function subscriptionDetails(code: string) {
		if (!CODE.test(code)) throw new PaystackError("The subscription code is not valid.", null);
		const data = await client.get<SubscriptionDetails>(`/subscription/${encodeURIComponent(code)}`);
		const token = typeof data.email_token === "string" && data.email_token ? data.email_token : null;
		const customer = isRecord(data.customer) ? text(data.customer.customer_code, CODE) : null;
		const authorization = isRecord(data.authorization) ? text(data.authorization.authorization_code, CODE) : null;
		const nextPayment = dateOf(data.next_payment_date);
		return { token, customer, authorization, nextPayment, status: data.status };
	}

	/** Confirms with Paystack that the transaction is a success for exactly this amount and currency. */
	async function confirmCharge(reference: string, amount: number, currency: string) {
		let data: Record<string, unknown>;
		try {
			data = await client.get<Record<string, unknown>>(`/transaction/verify/${encodeURIComponent(reference)}`);
		} catch (error) {
			if (error instanceof PaystackError && !error.retryable)
				throw new WebhookPayloadError("Paystack does not confirm this payment.");
			throw new WebhookRetry("The payment could not be confirmed with Paystack yet.");
		}
		if (
			!isRecord(data) ||
			data.status !== "success" ||
			data.reference !== reference ||
			data.currency !== currency ||
			data.amount !== amount
		)
			throw new WebhookPayloadError("The confirmed payment does not match the expected price.");
	}

	async function chargeSuccess(data: Record<string, unknown>): Promise<BillingEvent> {
		if (data.status !== "success") throw new WebhookIgnored("The charge was not a success.");
		const reference = text(data.reference, REFERENCE);
		if (!reference) throw new WebhookPayloadError("The charge has no usable reference.");
		const id = eventId("charge.success", data.id);
		const metadata = readCheckoutMetadata(secretKey, data.metadata);
		const planCode = planCodeOf(data);
		const planRow = planCode ? await store.planByCode(planCode) : null;
		// Not ours: no signed metadata and no plan we created.
		if (!metadata && !planRow) throw new WebhookIgnored("The charge is not for a CareerOS plan.");

		const customerCode = customerCodeOf(data);
		let orgId: string;
		let planId: string;
		let interval: BillingInterval;
		let seats: number;
		let expectedAmount: number;
		if (metadata) {
			orgId = metadata.orgId;
			({ planId, interval, seats } = metadata);
			if (planRow && (planRow.planId !== planId || planRow.interval !== interval || planRow.seats !== seats))
				throw new WebhookPayloadError("The charge's plan does not match the checkout.");
			// A plan-priced charge costs what its Paystack plan says; a one-period M-Pesa charge costs today's price.
			expectedAmount = planRow
				? planRow.amount
				: await priceOf(planId, interval, seats).catch(() => {
						throw new WebhookPayloadError("The checkout names a plan with no price.");
					});
		} else if (planRow) {
			const resolved = await store.resolveOrg({ customerCode });
			if (!resolved) throw new WebhookRetry("The renewal names a customer that has no organization yet.");
			orgId = resolved;
			({ planId, interval, seats } = planRow);
			expectedAmount = planRow.amount;
		} else {
			throw new WebhookIgnored();
		}
		const amount = wholeNumber(data.amount);
		if (amount === null || amount !== expectedAmount || data.currency !== PAYSTACK_CURRENCY)
			throw new WebhookPayloadError("The charge does not match the expected price.");
		await confirmCharge(reference, expectedAmount, PAYSTACK_CURRENCY);

		const paidAt = dateOf(data.paid_at) ?? now();
		let periodStart = paidAt;
		if (metadata?.method === "mpesa" && !planRow) {
			// Paying early for the next period starts it where the paid one ends, so no paid days are lost.
			const held = await store.currentPeriodEnd(orgId);
			if (held && held.getTime() > paidAt.getTime()) periodStart = held;
		}
		return {
			type: metadata ? "checkout.completed" : "payment.succeeded",
			provider: "paystack",
			providerEventId: id,
			orgId,
			planId,
			seats,
			interval,
			periodStart,
			periodEnd: addInterval(periodStart, interval),
			amount,
			currency: PAYSTACK_CURRENCY,
			providerCustomerId: customerCode,
		};
	}

	/** The organization of a subscription-bound event, from the ids saved on the first payment. Null when unknown. */
	const orgOfSubscription = (data: Record<string, unknown>, subscriptionCode: string | null) =>
		store.resolveOrg({ subscriptionCode, customerCode: customerCodeOf(data) });

	const bare = (type: BillingEvent["type"], id: string, orgId: string): BillingEvent => ({
		type,
		provider: "paystack",
		providerEventId: id,
		orgId,
		planId: null,
		seats: null,
		interval: null,
		periodStart: null,
		periodEnd: null,
		amount: null,
		currency: null,
	});

	async function subscriptionCreated(data: Record<string, unknown>): Promise<BillingEvent> {
		const code = text(data.subscription_code, CODE);
		if (!code) throw new WebhookPayloadError("The subscription has no code.");
		const orgId = await orgOfSubscription(data, code);
		if (!orgId) throw new WebhookRetry("The subscription names a customer that has no organization yet.");
		// Plan, seats and period come from the payments (a replacement subscription starts at the NEXT period), so this
		// event only records which provider subscription is the organization's.
		return {
			...bare("subscription.updated", eventId("subscription.create", data.id ?? code), orgId),
			providerSubscriptionId: code,
			providerCustomerId: customerCodeOf(data),
		};
	}

	async function paymentFailed(data: Record<string, unknown>): Promise<BillingEvent> {
		const subscription = isRecord(data.subscription) ? data.subscription : {};
		const code = text(subscription.subscription_code, CODE);
		const orgId = await orgOfSubscription(data, code);
		if (!orgId) throw new WebhookRetry("The failed invoice names a subscription that has no organization.");
		const key =
			data.invoice_code ?? data.id ?? (code ? `${code}-${String(data.created_at ?? data.paid_at ?? "")}` : null);
		return {
			...bare("payment.failed", eventId("invoice.payment_failed", key), orgId),
			amount: wholeNumber(data.amount),
		};
	}

	async function subscriptionEnding(type: string, data: Record<string, unknown>): Promise<BillingEvent> {
		const code = text(data.subscription_code, CODE);
		if (!code) throw new WebhookPayloadError("The subscription has no code.");
		const orgId = await orgOfSubscription(data, code);
		if (!orgId) throw new WebhookIgnored("The cancelled subscription is not known.");
		// No period end: the organization keeps the period it has paid for.
		return { ...bare("subscription.canceled", eventId(type, data.id ?? code), orgId), providerSubscriptionId: code };
	}

	return {
		id: "paystack",

		async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
			const method = input.method ?? "card";
			const amount = await priceOf(input.planId, input.interval, input.seats);
			if (method === "mpesa") return await initialize(input, "mpesa", amount, null);
			const plan = await planCodeFor({
				planId: input.planId,
				interval: input.interval,
				currency: PAYSTACK_CURRENCY,
				seats: input.seats,
				amount,
			});
			return await initialize(input, "card", amount, plan);
		},

		async changeSeats(input: ChangeSeatsInput) {
			// M-Pesa: nothing at Paystack; the next payment is made for the new count.
			if (!input.providerSubscriptionId) {
				await input.onPending?.({ seats: input.seats, replacesSubscriptionId: null });
				return;
			}
			const amount = await priceOf(input.planId, input.interval, input.seats);
			const current = await subscriptionDetails(input.providerSubscriptionId);
			if (!current.token || !current.customer || !current.authorization || !current.nextPayment)
				throw new PaystackError("The subscription cannot be changed at Paystack.", null);
			const plan = await planCodeFor({
				planId: input.planId,
				interval: input.interval,
				currency: PAYSTACK_CURRENCY,
				seats: input.seats,
				amount,
			});
			// A new subscription for the new seat count that starts when the current period ends, then the old one is
			// disabled. The new one is created first: if that fails nothing has changed.
			const created = await client.post<{ subscription_code?: unknown }>("/subscription", {
				customer: current.customer,
				plan,
				authorization: current.authorization,
				start_date: current.nextPayment.toISOString(),
			});
			const newCode = text(created.subscription_code, CODE);
			await input.onPending?.({ seats: input.seats, replacesSubscriptionId: input.providerSubscriptionId });
			try {
				await client.post("/subscription/disable", { code: input.providerSubscriptionId, token: current.token });
			} catch (error) {
				// Two subscriptions must never both stay live: take the new one down again.
				if (newCode) {
					const fresh = await subscriptionDetails(newCode).catch(() => null);
					if (fresh?.token)
						await client.post("/subscription/disable", { code: newCode, token: fresh.token }).catch(() => undefined);
				}
				throw error;
			}
		},

		async cancel(input: CancelInput) {
			if (!input.providerSubscriptionId) {
				// M-Pesa has no subscription to disable: it simply is not paid again. CareerOS records the cancellation
				// itself (the caller is the verified, authenticated owner of the organization).
				await applyEvent({
					...bare("subscription.canceled", `paystack.cancel:${input.orgId}:${now().getTime()}`, input.orgId),
					periodEnd: null,
				});
				return;
			}
			const current = await subscriptionDetails(input.providerSubscriptionId);
			if (!current.token) throw new PaystackError("The subscription cannot be cancelled at Paystack.", null);
			await client.post("/subscription/disable", { code: input.providerSubscriptionId, token: current.token });
		},

		async customerPortalUrl(input: PortalInput) {
			if (!input.providerSubscriptionId) return null;
			if (!CODE.test(input.providerSubscriptionId)) return null;
			const data = await client.get<{ link?: unknown }>(
				`/subscription/${encodeURIComponent(input.providerSubscriptionId)}/manage/link`,
			);
			return typeof data.link === "string" && data.link.startsWith("https://") ? data.link : null;
		},

		async verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<BillingEvent> {
			// 1. Signature first, over the raw bytes. Nothing below runs for a body that was not signed.
			checkSignature(secretKey, rawBody, headers);
			let parsed: unknown;
			try {
				parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
			} catch {
				throw new WebhookPayloadError();
			}
			if (!isRecord(parsed) || typeof parsed.event !== "string" || !isRecord(parsed.data))
				throw new WebhookPayloadError();
			const data = parsed.data;
			switch (parsed.event) {
				case "charge.success":
					return await chargeSuccess(data);
				case "subscription.create":
					return await subscriptionCreated(data);
				case "invoice.payment_failed":
					return await paymentFailed(data);
				case "subscription.not_renew":
				case "subscription.disable":
					return await subscriptionEnding(parsed.event, data);
				default:
					throw new WebhookIgnored();
			}
		},
	};
}
