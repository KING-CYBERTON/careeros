import type { BoardHttpOptions } from "../http";
import type { BoardFetcher, BoardRef, BoardSource, NormalizedJob } from "../types";
import { fetchBoardJson } from "../http";
import { boardRefSchema } from "../types";
import { ashby } from "./ashby";
import { greenhouse } from "./greenhouse";
import { lever, leverEu } from "./lever";

export const FETCHERS: Record<BoardSource, BoardFetcher> = {
	greenhouse,
	lever,
	lever_eu: leverEu,
	ashby,
};

/** Fetches one board: validates the reference again (it may come from a stored row), builds the URL, normalizes. */
export async function fetchBoard(ref: BoardRef, options?: BoardHttpOptions): Promise<NormalizedJob[]> {
	const { source, token } = boardRefSchema.parse(ref);
	const fetcher = FETCHERS[source];
	const json = await fetchBoardJson(fetcher.buildUrl(token), options);
	return fetcher.normalize(token, json);
}

export { ashby, greenhouse, lever, leverEu };
