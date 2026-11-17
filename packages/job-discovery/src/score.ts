import type { JobRemoteKind, NormalizedJob, RemotePreference, ScoringProfile } from "./types";

/**
 * Local relevance score, 0 to 100 (GTM-PLAN G3). Pure: no network, no database. It orders a long list cheaply so the AI
 * step (P4-T02) only reads the top N. The weights add up to 100.
 *
 * - TITLE (45): the title is the strongest single signal that a role is the kind the person wants.
 * - SKILLS (20): skills the person has, found in the posting, show the role can use them.
 * - KEYWORDS (10): free terms (an industry, a tool, a domain) the person cares about; weaker than skills.
 * - LOCATION (10): a place the person can work from.
 * - REMOTE (15): remote, hybrid or on-site fit is often a hard constraint, so it outweighs the place itself.
 *
 * A preference the person left empty gives half marks for its part (nothing to match is not a mismatch), so an
 * automation with only titles still ranks by title.
 */
export const SCORE_WEIGHTS = {
	title: 45,
	skills: 20,
	keywords: 10,
	location: 10,
	remote: 15,
} as const;

/** Half marks for a signal the person did not set. */
export const NEUTRAL = 0.5;
/** A title that shares words with a wanted title but not the phrase earns at most this share of the title weight. */
export const PARTIAL_TITLE_CAP = 0.7;
/** The description is read up to this many characters; the rest of a very long posting adds nothing. */
export const MAX_SCANNED_CHARACTERS = 50_000;

const STOP_WORDS = new Set(["a", "an", "and", "the", "of", "for", "in", "at", "to", "with", "or", "senior", "junior"]);

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Whole-term match that also works for terms such as "c++", "c#" and ".net" (no word boundary at those ends). */
function containsTerm(haystack: string, term: string): boolean {
	const needle = normalize(term);
	if (!needle) return false;
	return new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`).test(haystack);
}

function words(value: string): string[] {
	return normalize(value)
		.split(/[^a-z0-9+#.]+/)
		.map((word) => word.replace(/^\.+|\.+$/g, ""))
		.filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/** 1 for the wanted phrase inside the title, else the best share of a wanted title's words found, capped. */
export function titleFit(jobTitle: string, wanted: readonly string[]): number {
	const clean = wanted.map(normalize).filter(Boolean);
	if (clean.length === 0) return NEUTRAL;
	const title = normalize(jobTitle);
	const titleWords = new Set(words(title));
	let best = 0;
	for (const phrase of clean) {
		if (containsTerm(title, phrase)) return 1;
		const wantedWords = words(phrase);
		if (wantedWords.length === 0) continue;
		const share = wantedWords.filter((word) => titleWords.has(word)).length / wantedWords.length;
		best = Math.max(best, share * PARTIAL_TITLE_CAP);
	}
	return best;
}

/** The share of the terms found in the text; half marks when none were given. */
export function termFit(text: string, terms: readonly string[]): number {
	const clean = terms.map(normalize).filter(Boolean);
	if (clean.length === 0) return NEUTRAL;
	return clean.filter((term) => containsTerm(text, term)).length / clean.length;
}

const REMOTE_FIT: Record<Exclude<RemotePreference, "any">, Record<JobRemoteKind | "unknown", number>> = {
	remote: { remote: 1, hybrid: 0.3, onsite: 0, unknown: 0.4 },
	hybrid: { hybrid: 1, remote: 0.5, onsite: 0.5, unknown: 0.5 },
	onsite: { onsite: 1, hybrid: 0.6, remote: 0, unknown: 0.5 },
};

export function remoteFit(preference: RemotePreference, job: JobRemoteKind | null): number {
	if (preference === "any") return 1;
	return REMOTE_FIT[preference][job ?? "unknown"];
}

/** 1 when a wanted place is named in the location; a remote role fits any place; an unknown location is doubtful. */
export function locationFit(wanted: readonly string[], location: string | null, remote: JobRemoteKind | null): number {
	const clean = wanted.map(normalize).filter(Boolean);
	if (clean.length === 0) return 1;
	if (!location) return remote === "remote" ? 0.7 : 0.3;
	const place = normalize(location);
	if (clean.some((term) => containsTerm(place, term))) return 1;
	return remote === "remote" ? 0.7 : 0;
}

export type ScoreBreakdown = { title: number; skills: number; keywords: number; location: number; remote: number };

export function scoreBreakdown(
	job: Pick<NormalizedJob, "title" | "location" | "remote" | "descriptionHtml">,
	profile: ScoringProfile,
): ScoreBreakdown {
	// Tags are stripped crudely: this only decides what to look for, the stored HTML is already sanitized.
	const text = normalize(
		`${job.title} ${job.descriptionHtml.replace(/<[^>]*>/g, " ")}`.slice(0, MAX_SCANNED_CHARACTERS),
	);
	return {
		title: SCORE_WEIGHTS.title * titleFit(job.title, profile.titles),
		skills: SCORE_WEIGHTS.skills * termFit(text, profile.skills),
		keywords: SCORE_WEIGHTS.keywords * termFit(text, profile.keywords),
		location: SCORE_WEIGHTS.location * locationFit(profile.locations, job.location, job.remote),
		remote: SCORE_WEIGHTS.remote * remoteFit(profile.remote, job.remote),
	};
}

/** The score, 0 to 100, rounded to two decimals. */
export function scoreJob(
	job: Pick<NormalizedJob, "title" | "location" | "remote" | "descriptionHtml">,
	profile: ScoringProfile,
): number {
	const parts = scoreBreakdown(job, profile);
	const total = parts.title + parts.skills + parts.keywords + parts.location + parts.remote;
	return Math.round(Math.min(100, Math.max(0, total)) * 100) / 100;
}
