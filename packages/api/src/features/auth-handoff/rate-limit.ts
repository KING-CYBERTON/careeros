import { env } from "@reactive-resume/env/server";
import { rateLimitConfig } from "@reactive-resume/utils/rate-limit";
import { createRateLimiter } from "../../redis";

// CAREEROS (P2-T05): per client address, with the same on/off rule as every other limiter (production only, unless
// FLAG_DISABLE_API_RATE_LIMIT). `trustedClient` comes from the server adapter, never from a request header.

const isRateLimitEnabled = process.env.NODE_ENV === "production" && !env.FLAG_DISABLE_API_RATE_LIMIT;

export type HandoffLimit = keyof typeof rateLimitConfig.handoff;

const limiters = {
	begin: createRateLimiter("handoffBegin", rateLimitConfig.handoff.begin),
	redeem: createRateLimiter("handoffRedeem", rateLimitConfig.handoff.redeem),
	issue: createRateLimiter("handoffIssue", rateLimitConfig.handoff.issue),
} satisfies Record<HandoffLimit, ReturnType<typeof createRateLimiter>>;

/** Spends one try from the budget of `kind` for this client. `false` means the budget is spent. */
export async function consumeHandoffLimit(kind: HandoffLimit, trustedClient: string): Promise<boolean> {
	if (!isRateLimitEnabled) return true;
	return (await limiters[kind].limit(`handoff-${kind}:ip:${trustedClient.trim() || "unknown"}`)).success;
}
