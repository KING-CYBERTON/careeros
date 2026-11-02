import { t } from "@lingui/core/macro";
import { ORPCError } from "@orpc/client";
import { aiQuotaExceededMessage } from "@/features/ai/error";
import { showToast } from "@/ui";

// CAREEROS (P3-T03): the 80% notice, same as apps/web/src/libs/orpc/ai-quota.ts. The server sets this header on an AI
// response once the organization has used 80% of its allowance; the notice shows once per app session.
const AI_QUOTA_WARNING_HEADER = "x-ai-quota-warning";

let warned = false;

function readHeader(headers: unknown): string | null {
	if (headers instanceof Headers) return headers.get(AI_QUOTA_WARNING_HEADER);
	if (typeof headers === "object" && headers !== null) {
		const value = (headers as Record<string, unknown>)[AI_QUOTA_WARNING_HEADER];
		if (typeof value === "string") return value;
		if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	}
	return null;
}

/** Shows the 80% notice the first time a response carries the warning header. Safe to call on every response. */
export function noticeAiQuotaWarning(headers: unknown): void {
	if (warned || readHeader(headers) !== "true") return;
	warned = true;
	showToast({ message: t`Your organization has used 80% of this month's AI allowance.` });
}

let lastRefusal = 0;

/** Shows the 100% message when a call was refused because the allowance is used up (at most every ten seconds). */
export function noticeAiQuotaExceeded(error: unknown): void {
	if (!(error instanceof ORPCError) || error.code !== "AI_QUOTA_EXCEEDED") return;
	if (Date.now() - lastRefusal < 10_000) return;
	lastRefusal = Date.now();
	showToast({ message: aiQuotaExceededMessage() });
}
