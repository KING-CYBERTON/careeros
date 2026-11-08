import type { BillingEvent, BillingEventType } from "../events";
import type { PlanPrices } from "../pricing";
import type { BillingInterval } from "@reactive-resume/db/schema";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BILLING_EVENT_TYPES, WebhookIgnored, WebhookPayloadError, WebhookSignatureError } from "../events";
import { loadPlanPrices } from "../plans";
import { priceFor } from "../pricing";
import {
	type BillingProvider,
	type CancelInput,
	type ChangeSeatsInput,
	type CheckoutInput,
	type CheckoutResult,
	ProviderUnsupportedError,
} from "./types";

// CAREEROS (P3-T04, phase plan D1): the fake provider, for tests and for staging until the real one lands (P3-T05). It
// is enabled only by BILLING_PROVIDER=fake, which packages/env refuses when NODE_ENV=production. A checkout sends the
// browser to a local approve-or-decline page on the platform host; the page posts a signed event to the fake webhook.
// Everything is signed with HMAC-SHA256 under BILLING_FAKE_SECRET, so the webhook path is the real one: signature
// first, then the same intake as any provider.

export const FAKE_SIGNATURE_HEADER = "x-fake-signature";
/** A signature older than this is refused, so a captured request cannot be replayed later. */
export const FAKE_SIGNATURE_TOLERANCE_SECONDS = 300;
const SESSION_TTL_MS = 30 * 60 * 1000;

const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_SEATS = 100_000;

const hmac = (secret: string, message: string) => createHmac("sha256", secret).update(message).digest("hex");

function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

// --- Signed events -----------------------------------------------------------------------------------------------

export type FakeEventBody = {
	id: string;
	type: string;
	/** Seconds since the epoch. */
	created: number;
	/** The organization lives here and only here. */
	metadata: { orgId: string };
	data: {
		planId?: string | null;
		seats?: number | null;
		interval?: BillingInterval | null;
		periodStart?: string | null;
		periodEnd?: string | null;
		amount?: number | null;
		currency?: string | null;
		customerId?: string | null;
		subscriptionId?: string | null;
	};
};

export type SignedFakeEvent = { rawBody: Uint8Array; headers: Headers };

/** Signs an event the way the fake provider's webhook expects it. Used by the test page, the fake's own calls and tests. */
export function signFakeEvent(secret: string, body: FakeEventBody, now: Date = new Date()): SignedFakeEvent {
	const text = JSON.stringify(body);
	const timestamp = Math.floor(now.getTime() / 1000);
	const headers = new Headers({
		"content-type": "application/json",
		[FAKE_SIGNATURE_HEADER]: `t=${timestamp},v1=${hmac(secret, `${timestamp}.${text}`)}`,
	});
	return { rawBody: new TextEncoder().encode(text), headers };
}

export const newFakeEventId = () => `fake_evt_${randomBytes(12).toString("hex")}`;

function checkSignature(secret: string, rawBody: Uint8Array, headers: Headers, now: Date) {
	const header = headers.get(FAKE_SIGNATURE_HEADER);
	const match = header ? /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header) : null;
	if (!match?.[1] || !match[2]) throw new WebhookSignatureError();
	const timestamp = Number(match[1]);
	const expected = hmac(secret, `${match[1]}.${Buffer.from(rawBody).toString("utf8")}`);
	if (!safeEqual(expected, match[2])) throw new WebhookSignatureError();
	if (Math.abs(now.getTime() / 1000 - timestamp) > FAKE_SIGNATURE_TOLERANCE_SECONDS)
		throw new WebhookSignatureError("The webhook signature has expired.");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function optionalDate(value: unknown): Date | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new WebhookPayloadError();
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new WebhookPayloadError();
	return date;
}

function optionalString(value: unknown, pattern: RegExp): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !pattern.test(value)) throw new WebhookPayloadError();
	return value;
}

function optionalInteger(value: unknown, min: number, max: number): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
		throw new WebhookPayloadError();
	return value;
}

/** Reads a body whose signature is already good. The organization is `metadata.orgId`; no other field can name one. */
function parseEvent(rawBody: Uint8Array): BillingEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
	} catch {
		throw new WebhookPayloadError();
	}
	if (!isRecord(parsed)) throw new WebhookPayloadError();
	const id = optionalString(parsed.id, EVENT_ID);
	const type = typeof parsed.type === "string" ? parsed.type : null;
	if (!id || !type) throw new WebhookPayloadError();
	if (!(BILLING_EVENT_TYPES as readonly string[]).includes(type)) throw new WebhookIgnored();
	const metadata = isRecord(parsed.metadata) ? parsed.metadata : null;
	const orgId = metadata ? optionalString(metadata.orgId, ORG_ID) : null;
	if (!orgId) throw new WebhookPayloadError("The webhook event names no organization.");
	const data = isRecord(parsed.data) ? parsed.data : {};
	const interval = data.interval === undefined || data.interval === null ? null : data.interval;
	if (interval !== null && interval !== "month" && interval !== "year") throw new WebhookPayloadError();
	return {
		type: type as BillingEventType,
		provider: "fake",
		providerEventId: id,
		orgId,
		planId: optionalString(data.planId, /^[a-z][a-z0-9_-]{0,63}$/),
		seats: optionalInteger(data.seats, 1, MAX_SEATS),
		interval,
		periodStart: optionalDate(data.periodStart),
		periodEnd: optionalDate(data.periodEnd),
		amount: optionalInteger(data.amount, 0, Number.MAX_SAFE_INTEGER),
		currency: optionalString(data.currency, CURRENCY),
		providerCustomerId: optionalString(data.customerId, /^[A-Za-z0-9_.:-]{1,128}$/),
		providerSubscriptionId: optionalString(data.subscriptionId, /^[A-Za-z0-9_.:-]{1,128}$/),
	};
}

// --- The checkout session behind the test page -------------------------------------------------------------------

export type FakeCheckoutSession = {
	orgId: string;
	planId: string;
	interval: BillingInterval;
	seats: number;
	email: string;
	returnUrl: string;
	amount: number;
	currency: "USD";
	/** Milliseconds since the epoch. */
	expires: number;
};

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");

export function signFakeSession(secret: string, session: FakeCheckoutSession): string {
	const payload = b64(JSON.stringify(session));
	return `${payload}.${hmac(secret, `session.${payload}`)}`;
}

/** The session behind a test-page token, or null when the token is forged, malformed or expired. */
export function readFakeSession(secret: string, token: string, now: Date = new Date()): FakeCheckoutSession | null {
	const [payload, signature, extra] = token.split(".");
	if (!payload || !signature || extra !== undefined || !safeEqual(hmac(secret, `session.${payload}`), signature))
		return null;
	try {
		const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as FakeCheckoutSession;
		return isRecord(session) && typeof session.expires === "number" && session.expires > now.getTime() ? session : null;
	} catch {
		return null;
	}
}

const addInterval = (from: Date, interval: BillingInterval) => {
	const to = new Date(from);
	if (interval === "year") to.setUTCFullYear(to.getUTCFullYear() + 1);
	else to.setUTCMonth(to.getUTCMonth() + 1);
	return to;
};

/** The event the test page posts: approve completes the checkout, decline is a failed payment. */
export function fakeDecisionEvent(
	secret: string,
	session: FakeCheckoutSession,
	decision: "approve" | "decline",
	now: Date = new Date(),
): SignedFakeEvent {
	const base = { id: newFakeEventId(), created: Math.floor(now.getTime() / 1000), metadata: { orgId: session.orgId } };
	if (decision === "decline")
		return signFakeEvent(
			secret,
			{ ...base, type: "payment.failed", data: { planId: session.planId, amount: session.amount, currency: "USD" } },
			now,
		);
	return signFakeEvent(
		secret,
		{
			...base,
			type: "checkout.completed",
			data: {
				planId: session.planId,
				seats: session.seats,
				interval: session.interval,
				periodStart: now.toISOString(),
				periodEnd: addInterval(now, session.interval).toISOString(),
				amount: session.amount,
				currency: "USD",
				customerId: `fake_cus_${session.orgId}`.slice(0, 128),
				subscriptionId: `fake_sub_${session.orgId}`.slice(0, 128),
			},
		},
		now,
	);
}

// --- The provider -------------------------------------------------------------------------------------------------

export type FakeProviderOptions = {
	secret: string;
	/** The platform's public address (APP_URL): the test page lives there. */
	appUrl: string;
	/** Delivers a signed event to the webhook intake. The server wires it; without it the fake cannot change seats or cancel. */
	emit?: (event: SignedFakeEvent) => Promise<void>;
	loadPlan?: (planId: string) => Promise<PlanPrices | null>;
	now?: () => Date;
};

export function createFakeProvider(options: FakeProviderOptions): BillingProvider {
	const now = options.now ?? (() => new Date());
	const loadPlan = options.loadPlan ?? loadPlanPrices;
	const emit = (operation: string) => {
		if (!options.emit) throw new ProviderUnsupportedError("fake", operation);
		return options.emit;
	};
	const send = (type: BillingEventType, orgId: string, data: FakeEventBody["data"]) =>
		emit(type)(
			signFakeEvent(
				options.secret,
				{ id: newFakeEventId(), type, created: Math.floor(now().getTime() / 1000), metadata: { orgId }, data },
				now(),
			),
		);

	return {
		id: "fake",

		async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
			const plan = await loadPlan(input.planId);
			const amount = plan ? priceFor(plan, input.interval, input.seats, "USD") : null;
			if (amount === null) throw new Error(`The fake provider cannot price plan ${input.planId}.`);
			const token = signFakeSession(options.secret, {
				orgId: input.orgId,
				planId: input.planId,
				interval: input.interval,
				seats: input.seats,
				email: input.customerEmail,
				returnUrl: input.returnUrl,
				amount,
				currency: "USD",
				expires: now().getTime() + SESSION_TTL_MS,
			});
			const url = new URL("/api/billing/fake/checkout", options.appUrl);
			url.searchParams.set("session", token);
			return { redirectUrl: url.toString() };
		},

		async changeSeats(input: ChangeSeatsInput) {
			await send("subscription.updated", input.orgId, {
				planId: input.planId,
				seats: input.seats,
				interval: input.interval,
				subscriptionId: input.providerSubscriptionId,
			});
		},

		async cancel(input: CancelInput) {
			await send("subscription.canceled", input.orgId, {
				periodEnd: input.periodEnd?.toISOString() ?? null,
				subscriptionId: input.providerSubscriptionId,
			});
		},

		customerPortalUrl: () => Promise.resolve(null),

		verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<BillingEvent> {
			try {
				checkSignature(options.secret, rawBody, headers, now());
				return Promise.resolve(parseEvent(rawBody));
			} catch (error) {
				return Promise.reject(error);
			}
		},
	};
}
