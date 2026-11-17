// CAREEROS (P6-T02): the Plunk event webhook, `POST /api/email/webhook/plunk`. Plunk sends events only through a workflow
// "Webhook" step and does not sign them, so the protection is a static secret header. The rules, in the order they apply:
//   1. platform host only (404 elsewhere): the request host can never matter, no organization is involved;
//   2. rate limited per client address, before anything is read;
//   3. the header `x-careeros-webhook-secret` is compared in constant time with PLUNK_WEBHOOK_SECRET; missing or wrong is
//      401 and the body is not read, let alone parsed;
//   4. the body is capped at 64 KB (also by a middleware in app.ts);
//   5. a permanent bounce or a complaint puts the address (as sha256 of its lower-cased form) on the suppression list.
//      Everything else, a transient bounce, a delivery or an unknown event, is a 200 that changes nothing.
// Nothing is logged but the outcome: never a payload, a header, an address or the secret.
import type { HostContext } from "@careeros/tenancy";
import { createHash, timingSafeEqual } from "node:crypto";
import { consumeEmailWebhookLimit } from "@reactive-resume/api/features/email";
import { type SuppressionReason, suppressEmail } from "@reactive-resume/email/suppression";
import { env } from "@reactive-resume/env/server";
import { readCapped } from "./billing-webhook";

export const EMAIL_WEBHOOK_MAX_BYTES = 64 * 1024;
const EMAIL_WEBHOOK_SECRET_HEADER = "x-careeros-webhook-secret";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const json = (body: unknown, status: number, headers: HeadersInit = {}) =>
	Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** Equal-length digests make the comparison constant-time whatever the lengths of the two secrets. */
const secretMatches = (given: string | null, expected: string): boolean => {
	if (given === null) return false;
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(given), digest(expected));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The first record among the places Plunk's workflow payload may carry a field in. */
const firstOf = (sources: unknown[], read: (source: Record<string, unknown>) => string | undefined) => {
	for (const source of sources)
		if (isRecord(source)) {
			const value = read(source);
			if (value !== undefined) return value;
		}
	return undefined;
};

export type PlunkEvent = { reason: SuppressionReason; address: string; providerEmailId: string | undefined };

/**
 * What the payload asks for, or null when it asks for nothing (any other event, a transient bounce, a payload without an
 * address). The workflow payload is read leniently: the event name may sit under `event`, `type` or `trigger`, and
 * `bounceType` at the top or under `data`, `event` or `email`.
 */
export function suppressionFromPayload(payload: unknown): PlunkEvent | null {
	if (!isRecord(payload)) return null;
	const nested = [payload, payload.data, payload.event, payload.email];
	const name = firstOf(
		[payload, payload.data],
		(source) => text(source.event) ?? text(source.type) ?? text(source.trigger),
	);
	const eventName = name ?? firstOf([payload.event], (source) => text(source.type) ?? text(source.name));
	let reason: SuppressionReason;
	if (eventName === "email.complaint") reason = "complaint";
	else if (eventName === "email.bounce") {
		const bounceType = firstOf(nested, (source) => text(source.bounceType));
		if (bounceType?.toLowerCase() !== "permanent") return null;
		reason = "bounce";
	} else return null;

	const address = firstOf([payload.contact, isRecord(payload.data) ? payload.data.contact : undefined], (source) =>
		text(source.email),
	)?.trim();
	if (!address || address.length > 320 || !address.includes("@")) return null;
	const providerEmailId = firstOf([payload.email, payload.data], (source) => text(source.id) ?? text(source.emailId));
	return {
		reason,
		address,
		providerEmailId: providerEmailId && /^[A-Za-z0-9_.:-]{1,128}$/.test(providerEmailId) ? providerEmailId : undefined,
	};
}

export async function handleEmailWebhook(
	request: Request,
	host: HostContext,
	trustedClient: string,
): Promise<Response> {
	if (host.kind !== "platform") return json({ code: "NOT_FOUND" }, 404);
	if (!(await consumeEmailWebhookLimit(trustedClient)))
		return json({ code: "RATE_LIMITED" }, 429, { "Retry-After": "60" });

	const expected = env.PLUNK_WEBHOOK_SECRET;
	// Not configured (the provider is not plunk): there is no secret anyone could present.
	if (!expected) return json({ code: "NOT_FOUND" }, 404);
	if (!secretMatches(request.headers.get(EMAIL_WEBHOOK_SECRET_HEADER), expected))
		return json({ code: "UNAUTHORIZED" }, 401);

	const body = await readCapped(request, EMAIL_WEBHOOK_MAX_BYTES);
	if (!body) return json({ code: "PAYLOAD_TOO_LARGE" }, 413);

	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return json({ code: "BAD_PAYLOAD" }, 400);
	}

	const event = suppressionFromPayload(payload);
	if (!event) return json({ received: true, outcome: "ignored" }, 200);
	try {
		await suppressEmail(event.address, event.reason, event.providerEmailId);
	} catch (error) {
		console.error("[email] webhook outcome=error", error instanceof Error ? error.name : "");
		return json({ code: "PROCESSING_ERROR" }, 500);
	}
	console.info(`[email] webhook outcome=suppressed reason=${event.reason}`);
	return json({ received: true, outcome: "suppressed" }, 200);
}
