import type { BoardSource } from "./types";
import { fetchPublic } from "@reactive-resume/utils/url-security.node";
import { BoardFetchError } from "./types";

/**
 * The only hosts discovery ever talks to (GTM-PLAN G1): one fixed host per source. A fetch URL is built from this table
 * and a validated token, never from user input, and a redirect is followed only to a host in this list.
 */
export const BOARD_HOSTS: Record<BoardSource, string> = {
	greenhouse: "boards-api.greenhouse.io",
	lever: "api.lever.co",
	lever_eu: "api.eu.lever.co",
	ashby: "api.ashbyhq.com",
};

export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(Object.values(BOARD_HOSTS));

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 2;

export type FetchLike = (
	input: string,
	init: { signal: AbortSignal; redirect: "manual"; headers: HeadersInit },
) => Promise<Response>;

export type BoardHttpOptions = {
	/** The transport. Defaults to `fetchPublic`, which refuses private and loopback addresses when the socket opens. */
	fetchImpl?: FetchLike;
	/** Overrides the allow-list. Tests only: it is never reachable from the API. */
	allowedHosts?: ReadonlySet<string>;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
};

const defaultFetch: FetchLike = (input, init) => fetchPublic(input, init);

/** A URL that may be requested: https, no credentials, the default port, and a host on the allow-list. */
function checkTarget(url: URL, allowed: ReadonlySet<string>): void {
	if (url.protocol !== "https:") throw new BoardFetchError("redirect_refused", "Only https is allowed.");
	if (url.username || url.password) throw new BoardFetchError("redirect_refused", "Credentials in a URL are refused.");
	if (url.port && url.port !== "443") throw new BoardFetchError("redirect_refused", "A custom port is refused.");
	if (!allowed.has(url.hostname.toLowerCase()))
		throw new BoardFetchError("redirect_refused", "The host is not allowed.");
}

/** Reads the body, failing as soon as it passes the cap. */
async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel();
		throw new BoardFetchError("too_large", "The response is larger than the limit.");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	// A body that stalls never resolves `read()`, so the deadline is raced against it.
	const stalled = new Promise<never>((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	stalled.catch(() => {});
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), stalled]);
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new BoardFetchError("too_large", "The response is larger than the limit.");
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	}
	return Buffer.concat(chunks).toString("utf8");
}

function classify(error: unknown, signal: AbortSignal): BoardFetchError {
	if (error instanceof BoardFetchError) return error;
	if (signal.aborted) return new BoardFetchError("timeout", "The board did not answer in time.");
	// Only a short fixed reason: an error message from the transport may name an address.
	return new BoardFetchError("network", "The request failed.");
}

/**
 * GETs one board URL and returns its parsed JSON. Redirects are followed by hand, at most twice and only to an
 * allow-listed https host; the whole exchange (headers and body) shares one 15 s deadline; the body is capped at 5 MB;
 * the content type must be JSON. A failure carries a code and a short reason, never the response body.
 */
export async function fetchBoardJson(url: string, options: BoardHttpOptions = {}): Promise<unknown> {
	const allowed = options.allowedHosts ?? ALLOWED_HOSTS;
	const send = options.fetchImpl ?? defaultFetch;
	const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
	const signal = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);

	try {
		let current = new URL(url);
		for (let hop = 0; hop <= maxRedirects; hop++) {
			checkTarget(current, allowed);
			const response = await send(current.toString(), {
				signal,
				redirect: "manual",
				headers: { accept: "application/json" },
			});

			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel();
				const location = response.headers.get("location");
				if (!location) throw new BoardFetchError("redirect_refused", "A redirect had no target.", response.status);
				if (hop === maxRedirects) throw new BoardFetchError("redirect_refused", "Too many redirects.", response.status);
				let next: URL;
				try {
					next = new URL(location, current);
				} catch {
					throw new BoardFetchError("redirect_refused", "A redirect target was not a URL.", response.status);
				}
				current = next;
				continue;
			}

			if (response.status < 200 || response.status >= 300) {
				await response.body?.cancel();
				throw new BoardFetchError("http_status", `The board answered ${response.status}.`, response.status);
			}
			const contentType = response.headers.get("content-type") ?? "";
			if (!/\bjson\b/i.test(contentType)) {
				await response.body?.cancel();
				throw new BoardFetchError("bad_content_type", "The board did not answer with JSON.", response.status);
			}
			const text = await readCapped(response, options.maxBytes ?? MAX_RESPONSE_BYTES, signal);
			try {
				return JSON.parse(text) as unknown;
			} catch {
				throw new BoardFetchError("invalid_json", "The board's JSON could not be read.", response.status);
			}
		}
		throw new BoardFetchError("redirect_refused", "Too many redirects.");
	} catch (error) {
		throw classify(error, signal);
	}
}
