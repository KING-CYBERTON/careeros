import { BOARD_TOKEN_PATTERN, type BoardRef, type BoardSource } from "./schema";

// CAREEROS (P4-T03): reads a pasted job board URL into a source and a token, on the client. This only fills a form
// field in. The server never receives a URL: it builds its fetch address from a fixed host and the validated token (G1).

type HostRule = {
	source: BoardSource;
	/** How the token sits in the URL: the first path segment, a fixed prefix then the segment, or a query parameter. */
	prefix?: readonly string[];
	query?: string;
};

const HOSTS: Readonly<Record<string, HostRule>> = {
	"boards.greenhouse.io": { source: "greenhouse" },
	"job-boards.greenhouse.io": { source: "greenhouse" },
	"boards-api.greenhouse.io": { source: "greenhouse", prefix: ["v1", "boards"] },
	"jobs.lever.co": { source: "lever" },
	"api.lever.co": { source: "lever", prefix: ["v0", "postings"] },
	"jobs.eu.lever.co": { source: "lever_eu" },
	"api.eu.lever.co": { source: "lever_eu", prefix: ["v0", "postings"] },
	"jobs.ashbyhq.com": { source: "ashby" },
	"api.ashbyhq.com": { source: "ashby", prefix: ["posting-api", "job-board"] },
};

export type BoardUrlResult =
	/** A board from one of the four supported hosts. */
	| { kind: "board"; board: BoardRef }
	/** Not a URL at all: the text may be a plain token, so leave it as typed. */
	| { kind: "not_url" }
	/** A URL on a host discovery does not read. */
	| { kind: "unsupported" }
	/** A supported host with no usable board name in it. */
	| { kind: "no_token" };

/** True for text that cannot be a board token: it has a dot, slash, colon or whitespace. */
export const looksLikeUrl = (text: string) => /[\s./:?#@]/.test(text);

function tokenFrom(url: URL, rule: HostRule): string | undefined {
	let candidate: string | undefined;
	const segments = url.pathname.split("/").filter(Boolean);
	if (rule.prefix) {
		const head = segments.slice(0, rule.prefix.length).map((segment) => segment.toLowerCase());
		if (head.length === rule.prefix.length && head.every((segment, index) => segment === rule.prefix?.[index]))
			candidate = segments[rule.prefix.length];
	} else if (segments[0]?.toLowerCase() === "embed" && url.searchParams.has("for")) {
		// Greenhouse embeds: boards.greenhouse.io/embed/job_board?for=acme
		candidate = url.searchParams.get("for") ?? undefined;
	} else {
		candidate = segments[0];
	}
	if (candidate === undefined) return undefined;
	try {
		candidate = decodeURIComponent(candidate);
	} catch {
		return undefined;
	}
	candidate = candidate.trim();
	return BOARD_TOKEN_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * Reads a pasted URL (with or without `https://`) from Greenhouse, Lever, Lever EU or Ashby: the public board page or
 * the board's API address. Anything else is `unsupported`; text that is not URL-shaped is `not_url`.
 */
export function parseBoardUrl(input: string): BoardUrlResult {
	const text = input.trim();
	if (!text || !looksLikeUrl(text) || /\s/.test(text)) return { kind: "not_url" };
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
	} catch {
		return { kind: "unsupported" };
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "unsupported" };
	// Credentials in a URL and ports are not part of a public board address.
	if (url.username || url.password || url.port) return { kind: "unsupported" };
	const rule = HOSTS[url.hostname.toLowerCase()];
	if (!rule) return { kind: "unsupported" };
	const token = tokenFrom(url, rule);
	return token ? { kind: "board", board: { source: rule.source, token } } : { kind: "no_token" };
}
