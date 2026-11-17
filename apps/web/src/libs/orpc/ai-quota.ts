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

/** Shows the 80% notice once per session. Both the header and the `ai/quota` read end here. */
export function showAiQuotaWarning(): void {
	if (warned) return;
	warned = true;
	toast.add({ type: "warning", description: t`Your organization has used 80% of this month's AI allowance.` });
}

/** Shows the 80% notice the first time a response carries the warning header. Safe to call on every response. */
export function noticeAiQuotaWarning(headers: unknown): void {
	if (readHeader(headers) === "true") showAiQuotaWarning();
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

// ---- The guaranteed path: read `ai/quota` after AI calls ----
// The header can be lost (a batched response shares one header set), so after an AI call completes the client also asks
// `ai/quota` (cheap, cached on the server) and shows the same notice from the answer. The check waits a moment so the
// call's usage row is written first (a stream records when it ends) and runs at most once per minimum gap.

const AI_PATH_ROOTS = new Set(["ai", "agent", "career", "coverLetters", "applications"]);

/** Whether a call (an oRPC path) can use AI. `ai/quota` itself and calls of other features are not. */
export function isAiCall(path: readonly string[]): boolean {
	const [root, name] = path;
	if (!root || !AI_PATH_ROOTS.has(root)) return false;
	if (root === "ai") return name !== "quota";
	if (root === "applications") return name === "ai";
	return true;
}

type QuotaWatcherOptions = {
	fetchQuota: () => Promise<{ warning: boolean }>;
	/** Shows the 80% notice (once per session). */
	notify: () => void;
	delayMs?: number;
	minGapMs?: number;
};

export function createAiQuotaWatcher(options: QuotaWatcherOptions) {
	const delayMs = options.delayMs ?? 3000;
	const minGapMs = options.minGapMs ?? 15_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastCheck = Number.NEGATIVE_INFINITY;
	let done = false;

	const check = async () => {
		timer = undefined;
		lastCheck = Date.now();
		try {
			if ((await options.fetchQuota()).warning) {
				done = true;
				options.notify();
			}
		} catch {
			// The notice is a courtesy: a failed read is tried again after the next AI call.
		}
	};

	return {
		/** Call after any call completes (success or failure). */
		afterCall(path: readonly string[]) {
			if (done || timer !== undefined || !isAiCall(path)) return;
			const wait = Math.max(delayMs, lastCheck + minGapMs - Date.now());
			timer = setTimeout(() => void check(), wait);
		},
	};
}
