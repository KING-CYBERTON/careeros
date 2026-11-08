import type { BillingProvider } from "@careeros/billing";
import { resolveBillingProvider } from "@careeros/billing";
import { env } from "@reactive-resume/env/server";

// CAREEROS (P3-T04, phase plan D1): the provider this server is configured for (BILLING_PROVIDER). `none`, and the real
// providers until P3-T05 adds their adapters, resolve to null: billing is off.

let configured: BillingProvider | null | undefined;

export function getBillingProvider(): BillingProvider | null {
	if (configured !== undefined) return configured;
	configured = resolveBillingProvider({
		provider: env.BILLING_PROVIDER,
		fakeSecret: env.BILLING_FAKE_SECRET,
		appUrl: env.APP_URL,
		// The fake provider's own calls (change seats, cancel) enter through the same verified webhook path as the test page.
		emitFake: async (event) => {
			// Loaded on first use: webhook.ts needs this module to find the provider.
			const { processBillingWebhook } = await import("./webhook");
			const result = await processBillingWebhook("fake", event.rawBody, event.headers);
			if (result.kind !== "ok" && result.kind !== "ignored")
				throw new Error(`The fake billing event was refused (${result.kind}).`);
		},
	});
	return configured;
}

/** Whether billing is on for this server: a configured provider exists. */
export const isBillingEnabled = () => getBillingProvider() !== null;
