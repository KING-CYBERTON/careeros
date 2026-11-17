import { env } from "@reactive-resume/env/server";
import { createRateLimiter } from "../../redis";

// CAREEROS (P6-T02): the budget of the public Plunk event webhook, per client address (the trusted client from the server
// adapter, never a request header). Same on/off rule as the billing limiter: production only, unless
// FLAG_DISABLE_API_RATE_LIMIT. It exists to keep a flood of forged requests from reaching the secret check at full speed.

const isRateLimitEnabled = process.env.NODE_ENV === "production" && !env.FLAG_DISABLE_API_RATE_LIMIT;

const EMAIL_WEBHOOK_LIMIT = { maxRequests: 300, window: 60 * 1000 } as const;

const limiter = createRateLimiter("emailWebhook", EMAIL_WEBHOOK_LIMIT);

/** Spends one try from the budget for this client. `false` means the budget is spent. */
export async function consumeEmailWebhookLimit(trustedClient: string): Promise<boolean> {
	if (!isRateLimitEnabled) return true;
	return (await limiter.limit(`email-webhook:ip:${trustedClient.trim() || "unknown"}`)).success;
}
