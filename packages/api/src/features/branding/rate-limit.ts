import { createRatelimitMiddleware } from "@orpc/experimental-ratelimit";
import { env } from "@reactive-resume/env/server";
import { getClientKey } from "../../middleware/rate-limit";
import { createRateLimiter } from "../../redis";

// CAREEROS (P2-T01): the public branding lookup answers without a session, so it is limited per client address.
const enabled = process.env.NODE_ENV === "production" && !env.FLAG_DISABLE_API_RATE_LIMIT;
const limiter = createRateLimiter("brandingPublicLimiter", { maxRequests: 120, window: 60 * 1000 });
const disabled = {
	// oxlint-disable-next-line require-await -- The limiter contract returns a Promise even when rate limiting is disabled.
	limit: async () => ({ success: true, remaining: Number.POSITIVE_INFINITY, reset: Date.now() }),
};

export const brandingPublicRateLimit = createRatelimitMiddleware<{ trustedClient?: string }, unknown>({
	limiter: enabled ? limiter : disabled,
	key: ({ context }) => `branding-public:${getClientKey(context.trustedClient)}`,
});
