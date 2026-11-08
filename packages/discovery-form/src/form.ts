import {
	boardTokenSchema,
	DEFAULT_AI_TOP_N,
	dedupeTerms,
	MAX_AI_TOP_N,
	MAX_BOARDS_PER_SOURCE,
	MAX_NAME_LENGTH,
	MAX_TERM_LENGTH,
	MAX_TERMS,
	sourceCreateSchema,
	type BoardRef,
	type BoardSource,
	type DiscoverySchedule,
	type RemotePreference,
} from "./schema";

// CAREEROS (P4-T03): the form model shared by the web and mobile search forms. It validates a draft with the same
// Zod schema the server uses and returns error codes, not text: each app words them with its own Lingui strings.

export const TERM_FIELDS = ["titles", "skills", "keywords", "locations"] as const;
export type TermField = (typeof TERM_FIELDS)[number];

export type SearchDraft = {
	name: string;
	titles: string[];
	skills: string[];
	keywords: string[];
	locations: string[];
	remote: RemotePreference;
	/** Rows as typed: a row may still be missing its token. */
	boards: { source: BoardSource; token: string }[];
	schedule: DiscoverySchedule;
	aiTopN: number;
};

export const emptyDraft = (): SearchDraft => ({
	name: "",
	titles: [],
	skills: [],
	keywords: [],
	locations: [],
	remote: "any",
	boards: [],
	schedule: "daily",
	aiTopN: DEFAULT_AI_TOP_N,
});

export const FORM_FIELDS = ["name", ...TERM_FIELDS, "remote", "boards", "schedule", "aiTopN"] as const;
export type FormField = (typeof FORM_FIELDS)[number];

export type FormErrorCode =
	| "name_required"
	| "name_too_long"
	| "too_many_terms"
	| "term_too_long"
	| "too_many_boards"
	| "token_required"
	| "token_invalid"
	| "ai_top_n_invalid"
	| "ai_top_n_over_cap"
	| "invalid";

export type FormErrors = {
	fields: Partial<Record<FormField, FormErrorCode>>;
	/** Errors on single board rows, by row index. */
	boardRows: Record<number, FormErrorCode>;
};

export type ValidationResult =
	| { ok: true; value: ReturnType<typeof sourceCreateSchema.parse> }
	| { ok: false; errors: FormErrors };

export const hasErrors = (errors: FormErrors) =>
	Object.keys(errors.fields).length > 0 || Object.keys(errors.boardRows).length > 0;

export type ValidateOptions = {
	/** The plan's cap on AI-matched jobs, when the form knows it. At most `MAX_AI_TOP_N`. */
	maxAiTopN?: number;
};

const isFormField = (value: unknown): value is FormField => (FORM_FIELDS as readonly unknown[]).includes(value);

/**
 * Checks a draft against the server's create schema. A board row with no token is reported on its row, because the
 * server schema would only say the token is malformed.
 */
export function validateDraft(draft: SearchDraft, options: ValidateOptions = {}): ValidationResult {
	const errors: FormErrors = { fields: {}, boardRows: {} };
	const cap = Math.min(options.maxAiTopN ?? MAX_AI_TOP_N, MAX_AI_TOP_N);

	draft.boards.forEach((row, index) => {
		if (row.token.trim() === "") errors.boardRows[index] = "token_required";
	});
	if (draft.aiTopN > cap && draft.aiTopN <= MAX_AI_TOP_N) errors.fields.aiTopN = "ai_top_n_over_cap";

	const parsed = sourceCreateSchema.safeParse(draft);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			const [head, index] = issue.path;
			if (!isFormField(head)) continue;
			if (head === "boards" && typeof index === "number") {
				errors.boardRows[index] ??= issue.path[2] === "token" ? "token_invalid" : "invalid";
			} else {
				errors.fields[head] ??= codeFor(head, issue.code, issue.path.length > 1);
			}
		}
		if (!hasErrors(errors)) errors.fields.name = "invalid";
	}
	if (hasErrors(errors)) return { ok: false, errors };
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false, errors };
}

function codeFor(field: FormField, issueCode: string, nested = false): FormErrorCode {
	switch (field) {
		case "name":
			return issueCode === "too_big" ? "name_too_long" : "name_required";
		case "titles":
		case "skills":
		case "keywords":
		case "locations":
			if (nested) return issueCode === "too_big" ? "term_too_long" : "invalid";
			return issueCode === "too_big" ? "too_many_terms" : "invalid";
		case "boards":
			return issueCode === "too_big" ? "too_many_boards" : "invalid";
		case "aiTopN":
			return "ai_top_n_invalid";
		default:
			return "invalid";
	}
}

export type AddTermsResult = {
	terms: string[];
	/** Entries dropped for being over the length limit, or because the list is full. */
	error?: "term_too_long" | "too_many_terms";
};

/**
 * Adds typed or pasted entries to a chip list: split on commas and line breaks, trimmed, empty ones skipped, and
 * case-insensitive duplicates removed. An entry over 100 characters, or one past the 50th, is refused with an error.
 */
export function addTerms(current: readonly string[], raw: string): AddTermsResult {
	const entries = raw
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter(Boolean);
	let error: AddTermsResult["error"];
	const accepted = [...current];
	for (const entry of entries) {
		if (entry.length > MAX_TERM_LENGTH) {
			error = "term_too_long";
			continue;
		}
		if (accepted.some((item) => item.toLowerCase() === entry.toLowerCase())) continue;
		if (accepted.length >= MAX_TERMS) {
			error = "too_many_terms";
			continue;
		}
		accepted.push(entry);
	}
	return error ? { terms: accepted, error } : { terms: accepted };
}

export const removeTerm = (current: readonly string[], term: string) => current.filter((item) => item !== term);

/** A saved search as the form edits it. */
export const draftFromSource = (source: {
	name: string;
	titles: readonly string[];
	skills: readonly string[];
	keywords: readonly string[];
	locations: readonly string[];
	remote: RemotePreference;
	boards: readonly BoardRef[];
	schedule: DiscoverySchedule;
	aiTopN: number;
}): SearchDraft => ({
	name: source.name,
	titles: dedupeTerms(source.titles),
	skills: dedupeTerms(source.skills),
	keywords: dedupeTerms(source.keywords),
	locations: dedupeTerms(source.locations),
	remote: source.remote,
	boards: source.boards.map((board) => ({ source: board.source, token: board.token })),
	schedule: source.schedule,
	aiTopN: source.aiTopN,
});

export { MAX_AI_TOP_N, MAX_BOARDS_PER_SOURCE, MAX_NAME_LENGTH, MAX_TERM_LENGTH, MAX_TERMS };

/** True when a typed token alone is acceptable (used while typing, before the whole form is checked). */
export const isValidToken = (token: string) => boardTokenSchema.safeParse(token).success;

// What the server sends back: oRPC input validation failures carry `data.issues`, and the search limit carries a code.
export type ServerFormError = {
	/** Set when the member already has the most searches the server allows. */
	limitReached?: number;
	errors: FormErrors;
	/** True when the server's answer could be tied to a field or to the limit. */
	recognised: boolean;
};

const PATH_KEY = (segment: unknown): string | number | undefined => {
	if (typeof segment === "string" || typeof segment === "number") return segment;
	if (segment && typeof segment === "object" && "key" in segment) {
		const key = (segment as { key: unknown }).key;
		if (typeof key === "string" || typeof key === "number") return key;
	}
	return undefined;
};

/**
 * Maps a failed save to field errors. Reads an oRPC error by shape (`data.issues`, `data.code`), so it works for the
 * web client and the native client without importing either.
 */
export function readServerFormError(error: unknown): ServerFormError {
	const result: ServerFormError = { errors: { fields: {}, boardRows: {} }, recognised: false };
	const data = (error as { data?: unknown } | null | undefined)?.data;
	if (!data || typeof data !== "object") return result;
	const { code, limit, issues } = data as { code?: unknown; limit?: unknown; issues?: unknown };
	if (code === "AUTOMATION_LIMIT_REACHED") {
		result.limitReached = typeof limit === "number" ? limit : 0;
		result.recognised = true;
	}
	if (Array.isArray(issues)) {
		for (const raw of issues as { path?: unknown; code?: unknown }[]) {
			const path = Array.isArray(raw?.path) ? raw.path.map(PATH_KEY) : [];
			const [head, index] = path;
			if (!isFormField(head)) continue;
			result.recognised = true;
			if (head === "boards" && typeof index === "number") {
				result.errors.boardRows[index] ??= path[2] === "token" ? "token_invalid" : "invalid";
			} else {
				result.errors.fields[head] ??= codeFor(head, typeof raw.code === "string" ? raw.code : "", path.length > 1);
			}
		}
	}
	return result;
}
