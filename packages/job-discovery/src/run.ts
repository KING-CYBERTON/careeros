import type { BoardHttpOptions } from "./http";
import type { BoardError, BoardRef, NormalizedJob, ScoringProfile } from "./types";
import { requireOrgId, withOrgContext } from "@careeros/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { discoveredJob, discoveryRun, jobSource } from "@reactive-resume/db/schema";
import { scoreJob } from "./score";
import { fetchBoard } from "./sources";
import { BoardFetchError, boardListSchema } from "./types";

/** At most this many boards are fetched at a time within one run (GTM-PLAN G3). */
export const BOARD_CONCURRENCY = 5;
/** Rows per INSERT. Keeps a statement well under the parameter limit (21 columns per row). */
const INSERT_BATCH = 200;

export class DiscoveryError extends Error {
	readonly code: "not_found";
	constructor(code: "not_found", message: string) {
		super(message);
		this.name = "DiscoveryError";
		this.code = code;
	}
}

/** Fetches one board. Replaceable so tests (and the mocked 50-board run) never touch the network. */
export type BoardLoader = (ref: BoardRef) => Promise<NormalizedJob[]>;

export type RunDiscoveryOptions = {
	/** Defaults to the real fetchers behind the allow-listed, SSRF-safe transport. */
	loadBoard?: BoardLoader;
	http?: BoardHttpOptions;
};

export type RunSummary = {
	runId: string;
	status: "succeeded" | "failed" | "partial";
	fetched: number;
	new: number;
	duplicate: number;
	scored: number;
	aiMatched: number;
	errors: BoardError[];
};

/** Runs `task` over `items` with at most `limit` in flight; results keep the order of `items`. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await task(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

function toBoardError(ref: BoardRef, error: unknown): BoardError {
	if (error instanceof BoardFetchError) {
		return {
			source: ref.source,
			token: ref.token,
			code: error.code,
			...(error.status === undefined ? {} : { status: error.status }),
			reason: error.message,
		};
	}
	// A schema or programming error: never forward its message, which may quote input.
	return { source: ref.source, token: ref.token, code: "network", reason: "The board could not be read." };
}

/**
 * Runs one automation inside the caller's organization scope: fetch every board (five at a time), normalize, de-dupe
 * in the run, score locally, insert what the database has not seen, and record the run with its counts. It stops there;
 * the AI step, the schedule and accepting into the tracker are P4-T02.
 *
 * Call it inside `withOrgContext` (the API does), or use `runDiscoveryInOrg`. A dismissed or accepted job is a row that
 * stays, so the unique key refuses it again and it counts as a duplicate (GTM-PLAN G2).
 */
export async function runDiscovery(jobSourceId: string, options: RunDiscoveryOptions = {}): Promise<RunSummary> {
	const organizationId = requireOrgId();
	const [source] = await db
		.select()
		.from(jobSource)
		.where(and(eq(jobSource.id, jobSourceId), eq(jobSource.organizationId, organizationId)))
		.limit(1);
	if (!source) throw new DiscoveryError("not_found", "That automation does not exist.");

	// A stored list that no longer validates (hand edited row) is skipped board by board, not trusted.
	const parsed = boardListSchema.safeParse(source.boards);
	const boards: BoardRef[] = parsed.success ? parsed.data : [];
	const loadBoard = options.loadBoard ?? ((ref: BoardRef) => fetchBoard(ref, options.http));

	const [run] = await db
		.insert(discoveryRun)
		.values({ organizationId, jobSourceId: source.id })
		.returning({ id: discoveryRun.id });
	if (!run) throw new Error("The run could not be recorded.");
	await db
		.update(jobSource)
		.set({ lastRunAt: sql`now()` })
		.where(eq(jobSource.id, source.id));

	try {
		const outcomes = await mapWithConcurrency(boards, BOARD_CONCURRENCY, async (ref) => {
			try {
				return { ref, jobs: await loadBoard(ref), error: null as BoardError | null };
			} catch (error) {
				return { ref, jobs: [] as NormalizedJob[], error: toBoardError(ref, error) };
			}
		});

		const errors = outcomes.flatMap((outcome) => (outcome.error ? [outcome.error] : []));
		let fetched = 0;
		let duplicate = 0;
		const unique = new Map<string, NormalizedJob>();
		for (const outcome of outcomes) {
			for (const job of outcome.jobs) {
				fetched++;
				const key = `${job.source}\u0000${job.externalId}`;
				if (unique.has(key)) duplicate++;
				else unique.set(key, job);
			}
		}

		const profile: ScoringProfile = {
			titles: source.titles,
			skills: source.skills,
			keywords: source.keywords,
			locations: source.locations,
			remote: source.remote,
		};
		const rows = [...unique.values()].map((job) => ({
			organizationId,
			userId: source.userId,
			jobSourceId: source.id,
			source: job.source,
			externalId: job.externalId,
			boardToken: job.boardToken,
			title: job.title,
			company: job.company,
			location: job.location,
			remote: job.remote,
			url: job.url,
			postedAt: job.postedAt,
			descriptionHtml: job.descriptionHtml,
			localScore: scoreJob(job, profile),
			firstSeenRunId: run.id,
		}));

		let inserted = 0;
		for (let start = 0; start < rows.length; start += INSERT_BATCH) {
			const created = await db
				.insert(discoveredJob)
				.values(rows.slice(start, start + INSERT_BATCH))
				.onConflictDoNothing({
					target: [discoveredJob.organizationId, discoveredJob.userId, discoveredJob.source, discoveredJob.externalId],
				})
				.returning({ id: discoveredJob.id });
			inserted += created.length;
		}
		duplicate += rows.length - inserted;

		// Every board failed: the run failed. Some failed: partial (G1). None: succeeded. A source with no boards succeeds.
		const status = errors.length === 0 ? "succeeded" : errors.length === boards.length ? "failed" : "partial";
		const summary: RunSummary = {
			runId: run.id,
			status,
			fetched,
			new: inserted,
			duplicate,
			scored: rows.length,
			aiMatched: 0,
			errors,
		};
		await db
			.update(discoveryRun)
			.set({
				status,
				finishedAt: new Date(),
				fetched,
				new: inserted,
				duplicate,
				scored: rows.length,
				aiMatched: 0,
				errors,
			})
			.where(and(eq(discoveryRun.id, run.id), eq(discoveryRun.organizationId, organizationId)));
		return summary;
	} catch (error) {
		// Close the run so it does not stay "running" forever; the reason is a fixed word, never the error text.
		await db
			.update(discoveryRun)
			.set({
				status: "failed",
				finishedAt: new Date(),
				errors: [{ code: "internal", reason: "The run stopped unexpectedly." }],
			})
			.where(and(eq(discoveryRun.id, run.id), eq(discoveryRun.organizationId, organizationId)))
			.catch(() => {});
		throw error;
	}
}

/** For callers that have no scope yet (the scheduler of P4-T02): opens the organization's scope, then runs. */
export function runDiscoveryInOrg(organizationId: string, jobSourceId: string, options?: RunDiscoveryOptions) {
	return withOrgContext(organizationId, () => runDiscovery(jobSourceId, options));
}
