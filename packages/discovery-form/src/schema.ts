import z from "zod";

// CAREEROS (P4-T03): the rules for a job search (a `job_source`), in one place for the server, the web form and the
// mobile form. `@careeros/job-discovery` re-exports the constants, and `packages/api` builds its input schemas from
// `sourceFields`, so a limit changed here changes the API and both forms together. Pure: no database, no DOM.

/** The public job board APIs discovery can read (GTM-PLAN G1). Adzuna is v1.1. */
export const BOARD_SOURCES = ["greenhouse", "lever", "lever_eu", "ashby"] as const;
export type BoardSource = (typeof BOARD_SOURCES)[number];

/** Brand names, shown as they are in every language. */
export const BOARD_SOURCE_LABELS: Readonly<Record<BoardSource, string>> = {
	greenhouse: "Greenhouse",
	lever: "Lever",
	lever_eu: "Lever (EU)",
	ashby: "Ashby",
};

export const REMOTE_PREFERENCES = ["any", "remote", "onsite", "hybrid"] as const;
export type RemotePreference = (typeof REMOTE_PREFERENCES)[number];

export const SCHEDULES = ["daily", "weekly", "paused"] as const;
export type DiscoverySchedule = (typeof SCHEDULES)[number];

/** A job board named by its token. Never a URL: a board is looked up, not addressed (G1). */
export const BOARD_TOKEN_PATTERN = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
export const MAX_BOARDS_PER_SOURCE = 100;

export const MAX_NAME_LENGTH = 120;
export const MAX_TERMS = 50;
export const MAX_TERM_LENGTH = 100;
/** The most jobs one run may send to the AI match; a plan can lower it (`discovery_ai_top_n`). */
export const MAX_AI_TOP_N = 50;
export const DEFAULT_AI_TOP_N = 10;

export const boardTokenSchema = z
	.string()
	.trim()
	.regex(BOARD_TOKEN_PATTERN, "A board token is letters, digits, hyphens and underscores (at most 100).");

export const boardRefSchema = z.object({
	source: z.enum(BOARD_SOURCES),
	token: boardTokenSchema,
});
export type BoardRef = z.infer<typeof boardRefSchema>;

export const boardListSchema = z.array(boardRefSchema).max(MAX_BOARDS_PER_SOURCE);

/** Case-insensitive de-dupe that keeps the first spelling. */
export function dedupeTerms(items: readonly string[]): string[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = item.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const term = z.string().trim().min(1).max(MAX_TERM_LENGTH);
const termList = z.array(term).max(MAX_TERMS).transform(dedupeTerms);

/** A board appears once per source and token, whatever the case of the token. */
export function dedupeBoards<T extends BoardRef>(items: readonly T[]): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = `${item.source}:${item.token.toLowerCase()}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
const boards = boardListSchema.transform(dedupeBoards);

/** Built without defaults: a defaulted field left out of a patch would otherwise be reset. */
export const sourceFields = {
	name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
	titles: termList,
	skills: termList,
	keywords: termList,
	locations: termList,
	remote: z.enum(REMOTE_PREFERENCES),
	boards,
	schedule: z.enum(SCHEDULES),
	aiTopN: z.number().int().min(0).max(MAX_AI_TOP_N),
};

export const sourceCreateSchema = z.object({
	name: sourceFields.name,
	titles: sourceFields.titles.default([]),
	skills: sourceFields.skills.default([]),
	keywords: sourceFields.keywords.default([]),
	locations: sourceFields.locations.default([]),
	remote: sourceFields.remote.default("any"),
	boards: sourceFields.boards.default([]),
	schedule: sourceFields.schedule.default("daily"),
	aiTopN: sourceFields.aiTopN.default(DEFAULT_AI_TOP_N),
});

export const sourceUpdateSchema = z.object({ id: z.string().min(1) }).extend(z.object(sourceFields).partial().shape);
