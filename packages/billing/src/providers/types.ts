import type { BillingEvent, BillingProviderId } from "../events";
import type { BillingInterval } from "@reactive-resume/db/schema";

// CAREEROS (P3-T04, phase plan D1): what a payment provider adapter must do. The core knows only this interface, so a
// real provider (P3-T05) plugs in without touching plans, seats or quotas.

// CAREEROS (P3-T05): how the customer pays. Card renews by itself on providers that support subscriptions; M-Pesa pays
// one period at a time. A provider that has only one way to pay (the fake one) ignores it.
export const CHECKOUT_METHODS = ["card", "mpesa"] as const;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];

export type CheckoutInput = {
	orgId: string;
	planId: string;
	interval: BillingInterval;
	seats: number;
	customerEmail: string;
	/** Where the provider sends the customer back to. Built by the server, never taken from the client. */
	returnUrl: string;
	/** CAREEROS (P3-T05): how to pay; a provider treats a missing method as `card`. */
	method?: CheckoutMethod;
};

/** Either a page to send the browser to, or a prompt already pushed to the customer's phone (M-Pesa STK push). */
export type CheckoutResult = { redirectUrl: string } | { stkPushRequested: true };

export type ChangeSeatsInput = {
	orgId: string;
	planId: string;
	interval: BillingInterval;
	seats: number;
	providerSubscriptionId: string | null;
};

export type CancelInput = {
	orgId: string;
	providerSubscriptionId: string | null;
	/** The end of the period already paid for; the organization keeps working until then. */
	periodEnd: Date | null;
};

export type PortalInput = {
	orgId: string;
	providerCustomerId: string | null;
	returnUrl: string;
};

/** The adapter does not offer this operation. */
export class ProviderUnsupportedError extends Error {
	constructor(
		readonly provider: string,
		readonly operation: string,
	) {
		super(`The ${provider} billing provider does not support ${operation}.`);
		this.name = "ProviderUnsupportedError";
	}
}

export type BillingProvider = {
	readonly id: BillingProviderId;
	createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
	changeSeats(input: ChangeSeatsInput): Promise<void>;
	cancel(input: CancelInput): Promise<void>;
	/** A page where the customer manages the card and invoices, or null when the provider has none. */
	customerPortalUrl(input: PortalInput): Promise<string | null>;
	/**
	 * Verifies the signature over the RAW body first and only then reads it. Returns the normalized event, or throws
	 * `WebhookSignatureError` (bad signature: answered 400), `WebhookPayloadError` (signed but unusable: 400) or
	 * `WebhookIgnored` (signed, not an event type we act on: 200). Reads nothing but its arguments and its own secret:
	 * no database, no request host.
	 */
	verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<BillingEvent>;
};
