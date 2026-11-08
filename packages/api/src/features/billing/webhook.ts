import { applyBillingEvent, WebhookIgnored, WebhookPayloadError, WebhookSignatureError } from "@careeros/billing";
import { getBillingProvider } from "./provider";

// CAREEROS (P3-T04, phase plan D9): the provider-independent part of a webhook, below the HTTP adapter
// (apps/server/src/http/billing-webhook.ts). The order is the security property:
//   1. only the configured provider has a webhook;
//   2. the provider verifies the signature over the raw bytes - nothing has touched the database yet;
//   3. only then is the verified event applied (idempotently, in the organization its verified metadata names).
// The request host, headers and any other body field never choose the organization.

export type WebhookResult =
	| { kind: "not_found" }
	| { kind: "bad_signature" }
	| { kind: "bad_payload" }
	| { kind: "ignored" }
	| { kind: "ok"; outcome: "applied" | "duplicate" | "ignored"; reason: string | null; eventId: string };

const PROVIDER_PARAM = /^[a-z][a-z0-9]{1,15}$/;

/**
 * Verifies and applies one webhook delivery. Returns what to answer; throws only for a real processing error (the
 * caller answers 500 so the provider retries).
 */
export async function processBillingWebhook(
	providerParam: string,
	rawBody: Uint8Array,
	headers: Headers,
	now: Date = new Date(),
): Promise<WebhookResult> {
	const provider = getBillingProvider();
	// A provider with no webhook (manual), one that is not configured, or an unknown name all look the same from outside.
	if (!provider || provider.id === "manual" || !PROVIDER_PARAM.test(providerParam) || provider.id !== providerParam)
		return { kind: "not_found" };
	let event;
	try {
		event = await provider.verifyWebhook(rawBody, headers);
	} catch (error) {
		if (error instanceof WebhookSignatureError) return { kind: "bad_signature" };
		if (error instanceof WebhookPayloadError) return { kind: "bad_payload" };
		if (error instanceof WebhookIgnored) return { kind: "ignored" };
		// Anything else out of a verifier is a failure to verify, not a processing error: do not let it reach the database.
		return { kind: "bad_signature" };
	}
	const result = await applyBillingEvent(event, now);
	return { kind: "ok", outcome: result.outcome, reason: result.reason, eventId: event.providerEventId };
}
