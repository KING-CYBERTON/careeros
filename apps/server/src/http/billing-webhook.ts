// CAREEROS (P3-T04, phase plan D9): the payment provider webhook, `POST /api/billing/webhook/:provider`. The security
// rules, in the order they apply:
//   1. platform host only: the route is refused on organization hosts and custom domains (404), so the request host can
//      never matter - the organization comes from the provider's verified metadata alone;
//   2. rate limited per client address, before anything is read;
//   3. the raw body is capped at 256 KB (also by a middleware in app.ts, ahead of this handler);
//   4. the signature is verified over the raw bytes BEFORE anything touches the database; a bad one is 400;
//   5. a verified event is applied idempotently (a duplicate is a 200 no-op). 200 for duplicates and ignored types, 400
//      for a bad signature or an unusable payload, 500 only for a real processing error so the provider retries.
// Nothing is logged but the provider, the event id and the outcome: never a payload, a header or a signature.
import type { HostContext } from "@careeros/tenancy";
import { consumeBillingLimit, processBillingWebhook } from "@reactive-resume/api/features/billing";

export const BILLING_WEBHOOK_MAX_BYTES = 256 * 1024;

const NO_STORE = { "Cache-Control": "no-store" } as const;
const json = (body: unknown, status: number, headers: HeadersInit = {}) =>
	Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

const notFound = () => json({ defined: false, code: "NOT_FOUND", status: 404, message: "Not found" }, 404);

/** Reads at most `limit` bytes of the body; undefined when it is larger. */
export async function readCapped(request: Request, limit: number): Promise<Uint8Array | undefined> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) return undefined;
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

export async function handleBillingWebhook(
	request: Request,
	host: HostContext,
	provider: string,
	trustedClient: string,
): Promise<Response> {
	if (host.kind !== "platform") return notFound();
	if (!(await consumeBillingLimit("webhook", trustedClient)))
		return json({ code: "RATE_LIMITED" }, 429, { "Retry-After": "60" });
	const body = await readCapped(request, BILLING_WEBHOOK_MAX_BYTES);
	if (!body) return json({ code: "PAYLOAD_TOO_LARGE" }, 413);
	try {
		const result = await processBillingWebhook(provider, body, request.headers);
		switch (result.kind) {
			case "not_found":
				return notFound();
			case "bad_signature":
				console.warn(`[billing] webhook provider=${provider.slice(0, 16)} outcome=bad_signature`);
				return json({ code: "BAD_SIGNATURE" }, 400);
			case "bad_payload":
				console.warn(`[billing] webhook provider=${provider.slice(0, 16)} outcome=bad_payload`);
				return json({ code: "BAD_PAYLOAD" }, 400);
			case "ignored":
				return json({ received: true, outcome: "ignored" }, 200);
			case "ok":
				console.info(
					`[billing] webhook provider=${provider.slice(0, 16)} event=${result.eventId.slice(0, 64)} outcome=${result.outcome}`,
				);
				return json({ received: true, outcome: result.outcome }, 200);
		}
	} catch (error) {
		// A real processing error: 500 so the provider retries. The event was rolled back and left an `error` record.
		console.error(
			`[billing] webhook provider=${provider.slice(0, 16)} outcome=error`,
			error instanceof Error ? error.name : "",
		);
		return json({ code: "PROCESSING_ERROR" }, 500);
	}
}
