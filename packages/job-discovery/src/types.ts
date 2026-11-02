import z from "zod";

/** The public job board APIs discovery can read (GTM-PLAN G1). Adzuna is v1.1. */
export const BOARD_SOURCES = ["greenhouse", "lever", "lever_eu", "ashby"] as const;
export type BoardSource = (typeof BOARD_SOURCES)[number];

export const REMOTE_PREFERENCES = ["any", "remote", "onsite", "hybrid"] as const;
export type RemotePreference = (typeof REMOTE_PREFERENCES)[number];

/** How a posting describes where the work happens. `null` when the board does not say. */
export const JOB_REMOTE_KINDS = ["remote", "onsite", "hybrid"] as const;
export type JobRemoteKind = (typeof JOB_REMOTE_KINDS)[number];

export const SCHEDULES = ["daily", "weekly", "paused"] as const;
export type DiscoverySchedule = (typeof SCHEDULES)[number];

export const JOB_STATUSES = ["new", "accepted", "dismissed"] as const;
export type DiscoveredJobStatus = (typeof JOB_STATUSES)[number];

export const RUN_STATUSES = ["running", "succeeded", "failed", "partial"] as const;
export type DiscoveryRunStatus = (typeof RUN_STATUSES)[number];

/** A job board named by its token. Never a URL: a board is looked up, not addressed (G1). */
export const BOARD_TOKEN_PATTERN = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
export const MAX_BOARDS_PER_SOURCE = 100;

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

/** One posting as every fetcher returns it: already plain text where text is expected, HTML sanitized. */
export type NormalizedJob = {
	source: BoardSource;
	externalId: string;
	boardToken: string;
	title: string;
	company: string;
	location: string | null;
	remote: JobRemoteKind | null;
	/** https only. */
	url: string;
	postedAt: Date | null;
	/** Sanitized with the strict allow-list in `sanitize.ts`. */
	descriptionHtml: string;
};

/** What the preferences of an automation look like to the scorer. */
export type ScoringProfile = {
	titles: readonly string[];
	skills: readonly string[];
	keywords: readonly string[];
	locations: readonly string[];
	remote: RemotePreference;
};

/** A board-level failure as recorded on the run: a code and a short reason, never a response body. */
export type BoardError = {
	source: BoardSource;
	token: string;
	code: BoardFetchErrorCode;
	status?: number;
	reason: string;
};

export type BoardFetchErrorCode =
	| "http_status"
	| "timeout"
	| "too_large"
	| "bad_content_type"
	| "redirect_refused"
	| "invalid_json"
	| "invalid_shape"
	| "network";

export class BoardFetchError extends Error {
	readonly code: BoardFetchErrorCode;
	readonly status: number | undefined;
	constructor(code: BoardFetchErrorCode, reason: string, status?: number) {
		super(reason);
		this.name = "BoardFetchError";
		this.code = code;
		this.status = status;
	}
}

/** The common shape of a fetcher module: build the URL from the token, read the provider's JSON into jobs. */
export type BoardFetcher = {
	source: BoardSource;
	/** The only host this fetcher talks to. */
	host: string;
	/** Built from the fixed base and the encoded token. */
	buildUrl: (token: string) => string;
	/** Reads the provider's JSON. Unusable postings are dropped. Throws `BoardFetchError("invalid_shape")`. */
	normalize: (token: string, json: unknown) => NormalizedJob[];
};
