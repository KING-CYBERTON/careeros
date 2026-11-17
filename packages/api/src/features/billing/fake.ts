import { fakeDecisionEvent, readFakeSession, type FakeCheckoutSession } from "@careeros/billing";
import { env } from "@reactive-resume/env/server";
import { processBillingWebhook } from "./webhook";

// CAREEROS (P3-T04, phase plan D1): the fake provider's approve-or-decline test page, below the HTTP adapter
// (apps/server/src/http/billing-fake.ts). Only exists while BILLING_PROVIDER=fake (packages/env refuses that in
// production). The page is a capability: its session token is signed with BILLING_FAKE_SECRET and says which
// organization the checkout is for, so nobody can approve a payment for an organization they were not sent for.

/** The checkout behind a test-page token, or null when billing is not the fake provider or the token is not good. */
export function readFakeCheckout(token: string): FakeCheckoutSession | null {
	if (env.BILLING_PROVIDER !== "fake" || !env.BILLING_FAKE_SECRET) return null;
	return readFakeSession(env.BILLING_FAKE_SECRET, token);
}

export type FakeDecisionResult = { ok: true; returnUrl: string; result: "approved" | "declined" } | { ok: false };

/**
 * Posts the signed event for the decision to the fake webhook intake (the same signature check and idempotent apply as
 * any provider's webhook) and returns where to send the browser.
 */
export async function decideFakeCheckout(token: string, decision: "approve" | "decline"): Promise<FakeDecisionResult> {
	const session = readFakeCheckout(token);
	if (!session || !env.BILLING_FAKE_SECRET) return { ok: false };
	const signed = fakeDecisionEvent(env.BILLING_FAKE_SECRET, session, decision);
	const result = await processBillingWebhook("fake", signed.rawBody, signed.headers);
	if (result.kind !== "ok") throw new Error(`The fake billing event was refused (${result.kind}).`);
	return { ok: true, returnUrl: session.returnUrl, result: decision === "approve" ? "approved" : "declined" };
}
