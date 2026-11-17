// CAREEROS (P5-T03): the `source` marker an application carries when a CareerOS feature, not a member's own typing,
// created it. The column (`application.source`) is free text upstream (a member may type "LinkedIn" or "Referral"), so
// the markers are plain lowercase words. P4-T02 (job discovery) saves accepted jobs with `discovery`; the Job Clipper
// saves with `clipper`. Both import this one list instead of spelling the words again.

export const APPLICATION_SOURCES = {
	/** Saved from a page by the Job Clipper browser extension (P5-T03). */
	clipper: "clipper",
	/** Accepted from a job discovery review queue (P4-T02). */
	discovery: "discovery",
} as const;

export type ApplicationSourceMarker = (typeof APPLICATION_SOURCES)[keyof typeof APPLICATION_SOURCES];

/** Whether a stored or sent `source` is the Job Clipper's marker (case does not matter). */
export function isClipperSource(source: unknown): boolean {
	return typeof source === "string" && source.trim().toLowerCase() === APPLICATION_SOURCES.clipper;
}
