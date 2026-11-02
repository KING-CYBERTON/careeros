import type { BoardFetcher, JobRemoteKind, NormalizedJob } from "../types";
import { BOARD_HOSTS } from "../http";
import { BoardFetchError } from "../types";
import { buildJob, expectArray, isRecord, remoteFromText } from "./shared";

/**
 * Ashby public job board API. Docs: https://developers.ashbyhq.com/docs/public-job-posting-api:
 * `GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}?includeCompensation=true`. The answer is
 * `{ apiVersion, jobs: [{ id, title, location, workplaceType: Remote | Hybrid | OnSite, isRemote, isListed,
 * publishedAt, jobUrl, applyUrl, descriptionHtml, descriptionPlain, compensation }] }`. A posting with
 * `isListed: false` is not public and is skipped. The company name is not part of the answer, so the board name stands
 * in for it.
 */
const WORKPLACE: Record<string, JobRemoteKind> = {
	remote: "remote",
	hybrid: "hybrid",
	onsite: "onsite",
	"on-site": "onsite",
};

export const ashby: BoardFetcher = {
	source: "ashby",
	host: BOARD_HOSTS.ashby,
	buildUrl: (token) =>
		`https://${BOARD_HOSTS.ashby}/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`,
	normalize(token, json) {
		if (!isRecord(json)) throw new BoardFetchError("invalid_shape", "The board's answer was not an object.");
		const jobs: NormalizedJob[] = [];
		for (const item of expectArray(json.jobs, "job list")) {
			if (!isRecord(item) || item.isListed === false) continue;
			const workplace =
				typeof item.workplaceType === "string" ? WORKPLACE[item.workplaceType.toLowerCase()] : undefined;
			const job = buildJob({
				source: "ashby",
				boardToken: token,
				externalId: item.id,
				title: item.title,
				company: null,
				location: item.location,
				remote: workplace ?? (item.isRemote === true ? "remote" : remoteFromText(item.location)),
				url: item.jobUrl,
				postedAt: item.publishedAt,
				descriptionHtml: item.descriptionHtml,
			});
			if (job) jobs.push(job);
		}
		return jobs;
	},
};
