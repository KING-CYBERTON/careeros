import type { BoardFetcher, NormalizedJob } from "../types";
import { BOARD_HOSTS } from "../http";
import { BoardFetchError } from "../types";
import { buildJob, expectArray, isRecord, remoteFromText } from "./shared";

/**
 * Greenhouse Job Board API. Docs: https://developers.greenhouse.io/job-board.html (section "Jobs"; `content=true`
 * adds the description). The response is `{ jobs: [{ id, title, updated_at, first_published?, location: { name },
 * absolute_url, content, company_name? }], meta }`. `content` is HTML escaped once (`&lt;p&gt;`); the sanitizer
 * unescapes it. Greenhouse says nothing about remote work, so it is read from the location text.
 */
export const greenhouse: BoardFetcher = {
	source: "greenhouse",
	host: BOARD_HOSTS.greenhouse,
	buildUrl: (token) => `https://${BOARD_HOSTS.greenhouse}/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
	normalize(token, json) {
		if (!isRecord(json)) throw new BoardFetchError("invalid_shape", "The board's answer was not an object.");
		const jobs: NormalizedJob[] = [];
		for (const item of expectArray(json.jobs, "job list")) {
			if (!isRecord(item)) continue;
			const location = isRecord(item.location) ? item.location.name : null;
			const job = buildJob({
				source: "greenhouse",
				boardToken: token,
				externalId: item.id,
				title: item.title,
				company: item.company_name,
				location,
				remote: remoteFromText(location),
				url: item.absolute_url,
				postedAt: item.first_published ?? item.updated_at,
				descriptionHtml: item.content,
			});
			if (job) jobs.push(job);
		}
		return jobs;
	},
};
