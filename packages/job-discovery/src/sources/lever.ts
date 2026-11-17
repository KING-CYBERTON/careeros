import type { BoardFetcher, BoardSource, JobRemoteKind, NormalizedJob } from "../types";
import { BOARD_HOSTS } from "../http";
import { buildJob, expectArray, isRecord, remoteFromText } from "./shared";

/**
 * Lever Postings API. Docs: https://github.com/lever/postings-api (README, "Get a list of job postings"):
 * `GET /v0/postings/SITE?mode=json` on `api.lever.co`, and the same path on `api.eu.lever.co` for the EU instance. The
 * answer is a list of `{ id, text, categories: { location, allLocations, ... }, description (HTML), descriptionPlain,
 * lists: [{ text, content }], additional (HTML), hostedUrl, workplaceType: unspecified | on-site | remote | hybrid,
 * createdAt (epoch ms) }`. The company name is not part of the answer, so the site name stands in for it.
 */
const WORKPLACE: Record<string, JobRemoteKind> = {
	remote: "remote",
	hybrid: "hybrid",
	"on-site": "onsite",
	onsite: "onsite",
};

function descriptionOf(item: Record<string, unknown>): string {
	const parts: string[] = [];
	if (typeof item.description === "string") parts.push(item.description);
	if (Array.isArray(item.lists)) {
		for (const list of item.lists) {
			if (!isRecord(list)) continue;
			if (typeof list.text === "string") parts.push(`<h3>${list.text}</h3>`);
			if (typeof list.content === "string") parts.push(`<ul>${list.content}</ul>`);
		}
	}
	if (typeof item.additional === "string") parts.push(item.additional);
	return parts.join("\n");
}

function make(source: Extract<BoardSource, "lever" | "lever_eu">): BoardFetcher {
	const host = BOARD_HOSTS[source];
	return {
		source,
		host,
		buildUrl: (token) => `https://${host}/v0/postings/${encodeURIComponent(token)}?mode=json`,
		normalize(token, json) {
			const jobs: NormalizedJob[] = [];
			for (const item of expectArray(json, "posting list")) {
				if (!isRecord(item)) continue;
				const categories = isRecord(item.categories) ? item.categories : {};
				const workplace =
					typeof item.workplaceType === "string" ? WORKPLACE[item.workplaceType.toLowerCase()] : undefined;
				const job = buildJob({
					source,
					boardToken: token,
					externalId: item.id,
					title: item.text,
					company: null,
					location: categories.location,
					remote: workplace ?? remoteFromText(categories.location),
					url: item.hostedUrl,
					postedAt: item.createdAt,
					descriptionHtml: descriptionOf(item),
				});
				if (job) jobs.push(job);
			}
			return jobs;
		},
	};
}

export const lever = make("lever");
export const leverEu = make("lever_eu");
