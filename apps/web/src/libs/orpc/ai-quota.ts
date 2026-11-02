import { t } from "@lingui/core/macro";
import { ORPCError } from "@orpc/client";
import { toast } from "@reactive-resume/ui/components/toast";

// CAREEROS (P3-T03): the 80% notice. The server sets this header on an AI response once the organization has used 80% of
// its allowance (packages/api/src/middleware/ai-quota-warning.ts); the notice shows once per browser session.
export const AI_QUOTA_WARNING_HEADER = "x-ai-quota-warning";

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
	toast.add({ type: "warning", description: t`Your organization has used 80% of this month's AI allowance.` });
}

/** Test helper: lets the notice show again. */
export function resetAiQuotaNotice(): void {
	warned = false;
}

let lastRefusal = 0;

/** Shows the 100% message when a call was refused because the allowance is used up (at most every ten seconds). */
export function noticeAiQuotaExceeded(error: unknown): void {
	if (!(error instanceof ORPCError) || error.code !== "AI_QUOTA_EXCEEDED") return;
	if (Date.now() - lastRefusal < 10_000) return;
	lastRefusal = Date.now();
	toast.add({
		type: "error",
		description: t`Your organization has used all of this month's AI allowance. Add your own AI provider in Settings → AI & developer to keep going, or ask an admin about the plan.`,
	});
}
