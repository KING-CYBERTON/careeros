import { createRatelimitMiddleware } from "@orpc/experimental-ratelimit";
import { env } from "@reactive-resume/env/server";
import { createRateLimiter } from "../../redis";

// CAREEROS (P3-T08): the confirm call of a bulk invitation sends up to 500 emails, so it has a budget of its own, per
// organization (not per admin: a second admin gets no fresh budget). Same on/off rule as the other API limiters.

const isRateLimitEnabled = process.env.NODE_ENV === "production" && !env.FLAG_DISABLE_API_RATE_LIMIT;

const bulkInviteLimiter = createRateLimiter("orgBulkInviteLimiter", { maxRequests: 6, window: 60 * 60 * 1000 });
const disabledLimiter = {
	// oxlint-disable-next-line require-await -- The limiter contract returns a Promise even when rate limiting is disabled.
	limit: async () => ({ success: true, remaining: Number.POSITIVE_INFINITY, reset: Date.now() }),
};

export const orgBulkInviteRateLimit = createRatelimitMiddleware<{ organizationId?: string | undefined }, unknown>({
	limiter: isRateLimitEnabled ? bulkInviteLimiter : disabledLimiter,
	key: ({ context }) => `org-bulk-invite:${context.organizationId ?? "none"}`,
});
