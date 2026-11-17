import { env } from "@reactive-resume/env/server";
import { createRateLimiter } from "../../redis";

// CAREEROS (P3-T04): the budgets of the public billing endpoints, per client address (the trusted client from the server
// adapter, never a request header). Same on/off rule as every other limiter: production only, unless
// FLAG_DISABLE_API_RATE_LIMIT. Provider webhooks come from a handful of addresses and arrive in bursts, so the webhook
// budget is generous; it exists to keep a flood of forged requests from reaching the signature check at full speed.

const isRateLimitEnabled = process.env.NODE_ENV === "production" && !env.FLAG_DISABLE_API_RATE_LIMIT;

export const BILLING_LIMITS = {
	webhook: { maxRequests: 300, window: 60 * 1000 },
	fakeCheckout: { maxRequests: 60, window: 60 * 1000 },
} as const;

export type BillingLimit = keyof typeof BILLING_LIMITS;

const limiters = {
	webhook: createRateLimiter("billingWebhook", BILLING_LIMITS.webhook),
	fakeCheckout: createRateLimiter("billingFakeCheckout", BILLING_LIMITS.fakeCheckout),
} satisfies Record<BillingLimit, ReturnType<typeof createRateLimiter>>;

/** Spends one try from the budget of `kind` for this client. `false` means the budget is spent. */
export async function consumeBillingLimit(kind: BillingLimit, trustedClient: string): Promise<boolean> {
	if (!isRateLimitEnabled) return true;
	return (await limiters[kind].limit(`billing-${kind}:ip:${trustedClient.trim() || "unknown"}`)).success;
}
