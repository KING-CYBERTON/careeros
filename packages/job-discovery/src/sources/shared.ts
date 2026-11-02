import type { JobRemoteKind, NormalizedJob } from "../types";
import { plainText, safeHttpsUrl, sanitizeDescription } from "../sanitize";
import { BoardFetchError } from "../types";

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectArray(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw new BoardFetchError("invalid_shape", `The board's ${what} was not a list.`);
	return value;
}

/** A provider id as text, from a string or a safe integer. Anything else is not an id. */
export function idText(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	return null;
}

/** A date from an ISO string or epoch milliseconds, or null. Dates before 2000 or in the far future are noise. */
export function dateOf(value: unknown): Date | null {
	const date =
		typeof value === "number" ? new Date(value) : typeof value === "string" && value ? new Date(value) : null;
	if (!date || Number.isNaN(date.getTime())) return null;
	const year = date.getUTCFullYear();
	return year >= 2000 && year <= 2100 ? date : null;
}

/** Builds a job, or null when it lacks an id, a title or an https address (the posting is unusable, not an error). */
export function buildJob(
	input: Pick<NormalizedJob, "source" | "boardToken"> & {
		externalId: unknown;
		title: unknown;
		company: unknown;
		location: unknown;
		remote: JobRemoteKind | null;
		url: unknown;
		postedAt: unknown;
		descriptionHtml: unknown;
	},
): NormalizedJob | null {
	const externalId = idText(input.externalId);
	const title = plainText(input.title);
	const url = safeHttpsUrl(input.url);
	if (!externalId || !title || !url) return null;
	const location = plainText(input.location);
	return {
		source: input.source,
		externalId,
		boardToken: input.boardToken,
		title,
		company: plainText(input.company) || input.boardToken,
		location: location || null,
		remote: input.remote,
		url,
		postedAt: dateOf(input.postedAt),
		descriptionHtml: sanitizeDescription(input.descriptionHtml),
	};
}

/** Reads a remote hint from free text such as a location ("Remote - EMEA", "Hybrid, London"). */
export function remoteFromText(value: unknown): JobRemoteKind | null {
	if (typeof value !== "string") return null;
	const text = value.toLowerCase();
	if (/\bhybrid\b/.test(text)) return "hybrid";
	if (/\bremote\b|\bwork from home\b|\banywhere\b/.test(text)) return "remote";
	if (/\bon-?site\b|\bin[- ]office\b/.test(text)) return "onsite";
	return null;
}
