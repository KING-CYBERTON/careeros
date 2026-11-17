import z from "zod";

// CAREEROS (P4-T02, GTM-PLAN G3 and G4): the pure parts of the AI match. The model call itself lives in
// `@reactive-resume/api` (it needs the metered platform model); this file holds what is checked here: the shape of the
// model's answer and which found jobs are sent at all.

/** The longest reason the model may give. */
export const MAX_AI_SUMMARY_LENGTH = 280;

// A tag-like run of characters or a control character means the text is not plain text; it is refused, never repaired.
const HAS_MARKUP = /<\/?[a-z][^>]*>/i;
/** Control characters other than tab, line feed and carriage return, and DEL. */
const hasControl = (text: string) =>
	[...text].some((char) => {
		const code = char.charCodeAt(0);
		return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
	});

/** What the model must answer: a score from 0 to 100 and a short plain-text reason. Invalid output is refused whole. */
export const aiMatchOutputSchema = z.object({
	score: z.number().finite().min(0).max(100),
	summary: z
		.string()
		.trim()
		.min(1)
		.max(MAX_AI_SUMMARY_LENGTH)
		.refine((text) => !HAS_MARKUP.test(text) && !hasControl(text), "The summary must be plain text."),
});
export type AiMatchOutput = z.infer<typeof aiMatchOutputSchema>;

/** The model's answer, or `null` when it does not validate. The score is rounded to two decimals (the column's scale). */
export function parseAiMatchOutput(value: unknown): AiMatchOutput | null {
	const parsed = aiMatchOutputSchema.safeParse(value);
	if (!parsed.success) return null;
	return { score: Math.round(parsed.data.score * 100) / 100, summary: parsed.data.summary };
}

/** Why the AI step of a run did not run, or stopped early. Stored on `discovery_run.ai_skipped_reason`. */
export type AiSkippedReason = "no_platform_ai" | "quota_exhausted" | "provider_error";

/**
 * The most jobs one run sends to the model: the automation's own `ai_top_n`, never more than the plan's cap, never
 * negative. Whole numbers only.
 */
export function aiCallBudget(aiTopN: number, planCap: number): number {
	const n = Number.isFinite(aiTopN) ? Math.floor(aiTopN) : 0;
	const cap = Number.isFinite(planCap) ? Math.floor(planCap) : 0;
	return Math.max(0, Math.min(n, cap));
}

/** The best `budget` jobs of a run by local score (ties by id, so the choice is stable). The input is not changed. */
export function selectTopN<T extends { id: string; localScore: number }>(jobs: readonly T[], budget: number): T[] {
	const take = Math.max(0, Math.floor(budget));
	return [...jobs]
		.sort((a, b) => b.localScore - a.localScore || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.slice(0, take);
}

/** One found job as the model sees it: plain text only. */
export type AiMatchJob = {
	id: string;
	title: string;
	company: string;
	location: string | null;
	remote: string | null;
	/** Plain text made from the sanitized description, cut to a safe length. */
	description: string;
};

/** What the AI step knows about the member: the preferences of the automation. */
export type AiMatchProfile = {
	titles: readonly string[];
	skills: readonly string[];
	keywords: readonly string[];
	locations: readonly string[];
	remote: string;
};

/**
 * The AI step, supplied by the caller (it needs the metered platform model). `check` runs once before any call and
 * returns a reason to skip the step, or `null` to go ahead. `match` makes one model call for one job and reports that
 * the call was made (`called`) with the validated answer, or `null` when the answer was invalid. It throws
 * `AiQuotaStop` when the allowance ran out before the call (nothing was called or metered) and `AiProviderStop` when
 * the provider failed.
 */
export type AiMatcher = {
	check: () => Promise<AiSkippedReason | null>;
	match: (job: AiMatchJob, profile: AiMatchProfile) => Promise<{ called: true; output: AiMatchOutput | null }>;
};

/** Thrown by an `AiMatcher` when the organization's AI allowance ran out before a call. */
export class AiQuotaStop extends Error {
	constructor() {
		super("The AI allowance is used up.");
		this.name = "AiQuotaStop";
	}
}

/** Thrown by an `AiMatcher` when the provider failed (no usable answer, no usage written). */
export class AiProviderStop extends Error {
	constructor() {
		super("The AI provider failed.");
		this.name = "AiProviderStop";
	}
}
