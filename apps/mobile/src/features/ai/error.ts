import { t } from "@lingui/core/macro";
import { ORPCError } from "@orpc/client";

/** CAREEROS (P3-T03): shown wherever an AI action is refused because the allowance is used up. */
export function aiQuotaExceededMessage() {
	return t`Your organization has used all of this month's AI allowance. Add your own AI provider in Settings to keep going, or ask an admin about the plan.`;
}

export function aiSettingsError(error: unknown, testing = false) {
	if (error instanceof ORPCError) {
		// CAREEROS (P3-T03): the organization's AI allowance is used up.
		if (error.code === "AI_QUOTA_EXCEEDED") return aiQuotaExceededMessage();
		if (testing && (error.code === "BAD_GATEWAY" || error.code === "NOT_FOUND"))
			return t`The test didn't run. Try again.`;
		if (error.code === "PRECONDITION_FAILED")
			return t`Ask your server administrator to enable credential encryption or configure a shared connection.`;
		if (error.code === "BAD_REQUEST") return t`That provider setup isn't valid. Check the key, model and base URL.`;
		if (error.code === "FORBIDDEN") return t`This connection is managed by your server.`;
		if (error.code === "UNAUTHORIZED") return t`Your session expired. Sign in again.`;
		if (error.code === "RATE_LIMIT_EXCEEDED" || error.code === "TOO_MANY_REQUESTS")
			return t`Too many requests. Try again later.`;
	}
	return t`The connection couldn't be loaded or saved. Try again.`;
}
