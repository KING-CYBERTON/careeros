import type { BillingInterval } from "@reactive-resume/db/schema";

// CAREEROS (P3-T04, phase plan D1, D9): the provider-independent shape of what a payment provider tells us. Each provider
// adapter verifies its own webhook and turns it into one of these; nothing else in the system sees a provider payload.

export const BILLING_EVENT_TYPES = [
	"checkout.completed",
	"payment.succeeded",
	"payment.failed",
	"subscription.updated",
	"subscription.canceled",
] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

/** The providers that can send events. `manual` records payments by hand and has no webhook. */
export const BILLING_PROVIDER_IDS = ["fake", "manual", "paystack", "stripe", "mpesa"] as const;
export type BillingProviderId = (typeof BILLING_PROVIDER_IDS)[number];

export type BillingEvent = {
	type: BillingEventType;
	provider: BillingProviderId;
	/** The provider's own id for this event. Together with `provider` it is the idempotency key. */
	providerEventId: string;
	/**
	 * The organization, taken from the provider's VERIFIED metadata (what CareerOS put there when it created the checkout)
	 * and from nowhere else: never the request host, a header or an unrelated body field.
	 */
	orgId: string;
	/** Null when the event does not say (a failed payment, for example). */
	planId: string | null;
	seats: number | null;
	interval: BillingInterval | null;
	periodStart: Date | null;
	periodEnd: Date | null;
	/** Integer, in the smallest unit of `currency` as the provider reports it (cents for USD). Null when none was charged. */
	amount: number | null;
	currency: string | null;
	providerCustomerId?: string | null;
	providerSubscriptionId?: string | null;
};

/** Thrown by `verifyWebhook` when the signature (or its timestamp) is wrong. Answered with 400; nothing was touched. */
export class WebhookSignatureError extends Error {
	constructor(message = "The webhook signature is not valid.") {
		super(message);
		this.name = "WebhookSignatureError";
	}
}

/** Thrown by `verifyWebhook` after a good signature when the payload is not an event we understand. Answered with 400. */
export class WebhookPayloadError extends Error {
	constructor(message = "The webhook payload is not valid.") {
		super(message);
		this.name = "WebhookPayloadError";
	}
}

/** Thrown by `verifyWebhook` after a good signature for an event type we do not act on. Answered with 200. */
export class WebhookIgnored extends Error {
	constructor(message = "The webhook event type is not handled.") {
		super(message);
		this.name = "WebhookIgnored";
	}
}
