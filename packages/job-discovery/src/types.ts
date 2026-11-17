import type { BoardSource, RemotePreference } from "@careeros/discovery-form";

// CAREEROS (P4-T03): the search rules (sources, schedules, token pattern, board schemas) moved to
// `@careeros/discovery-form` so the web and mobile forms validate with the same code. They are re-exported here.
export {
	BOARD_SOURCES,
	BOARD_TOKEN_PATTERN,
	MAX_BOARDS_PER_SOURCE,
	REMOTE_PREFERENCES,
	SCHEDULES,
	boardListSchema,
	boardRefSchema,
	boardTokenSchema,
} from "@careeros/discovery-form";
export type { BoardRef, BoardSource, DiscoverySchedule, RemotePreference } from "@careeros/discovery-form";

/** How a posting describes where the work happens. `null` when the board does not say. */
export const JOB_REMOTE_KINDS = ["remote", "onsite", "hybrid"] as const;
export type JobRemoteKind = (typeof JOB_REMOTE_KINDS)[number];

export const JOB_STATUSES = ["new", "accepted", "dismissed"] as const;
export type DiscoveredJobStatus = (typeof JOB_STATUSES)[number];

export const RUN_STATUSES = ["running", "succeeded", "failed", "partial"] as const;
export type DiscoveryRunStatus = (typeof RUN_STATUSES)[number];

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
