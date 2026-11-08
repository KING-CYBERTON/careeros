import type { AiMatcher, AiMatchJob, AiSkippedReason } from "./ai";
import type { BoardHttpOptions } from "./http";
import type { BoardError, BoardRef, NormalizedJob, ScoringProfile } from "./types";
import { requireOrgId, withOrgContext } from "@careeros/tenancy";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { discoveredJob, discoveryRun, jobSource } from "@reactive-resume/db/schema";
import { aiCallBudget, AiQuotaStop, selectTopN } from "./ai";
import { descriptionToText } from "./sanitize";
import { scoreJob } from "./score";
import { fetchBoard } from "./sources";
import { BoardFetchError, boardListSchema } from "./types";

/** At most this many boards are fetched at a time within one run (GTM-PLAN G3). */
export const BOARD_CONCURRENCY = 5;
/** At most this many model calls are in flight at a time within one run (P4-T02). */
export const AI_CONCURRENCY = 3;
/** The description sent to the model is cut to this many characters (a posting's first part says what the role is). */
export const AI_DESCRIPTION_CHARS = 6000;
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

/** How a run started (P4-T02). A scheduled run never touches `last_run_at`, so it cannot block `runNow`. */
export type RunTrigger = "manual" | "scheduled";

export type RunDiscoveryOptions = {
	/** Defaults to the real fetchers behind the allow-listed, SSRF-safe transport. */
	loadBoard?: BoardLoader;
	http?: BoardHttpOptions;
	/** Defaults to `manual`. */
	trigger?: RunTrigger;
	/** The AI step (P4-T02). Without one, no job is sent to a model. */
	ai?: AiMatcher;
	/** The plan's cap on jobs sent to the model per run; the run sends at most `min(ai_top_n, aiPlanCap)`. Default 0. */
	aiPlanCap?: number;
};

export type RunSummary = {
	runId: string;
	status: "running" | "succeeded" | "failed" | "partial";
	fetched: number;
	new: number;
	duplicate: number;
	scored: number;
	/** The number of model calls this run made. */
	aiMatched: number;
	/** The most calls this run planned (the top jobs of this run, at most `min(ai_top_n, plan cap)`). */
	aiPlanned: number;
	/** Why the AI step did not run or stopped early; the local scores stay. */
	aiSkippedReason: AiSkippedReason | null;
	errors: BoardError[];
};

/** A run that has been recorded as `running` and not yet carried out. */
export type BegunRun = {
	runId: string;
	source: typeof jobSource.$inferSelect;
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
 * Records a run as `running` and stamps the automation (a manual run sets `last_run_at`, a scheduled one
 * `last_scheduled_run_at`), inside the caller's organization scope. `executeDiscovery` then carries it out: the
 * split lets `runNow` answer as soon as the run exists and carry on in the background.
 */
export async function beginDiscovery(
	jobSourceId: string,
	options: Pick<RunDiscoveryOptions, "trigger"> = {},
): Promise<BegunRun> {
	const organizationId = requireOrgId();
	const trigger = options.trigger ?? "manual";
	const [source] = await db
		.select()
		.from(jobSource)
		.where(and(eq(jobSource.id, jobSourceId), eq(jobSource.organizationId, organizationId)))
		.limit(1);
	if (!source) throw new DiscoveryError("not_found", "That automation does not exist.");

	const [run] = await db
		.insert(discoveryRun)
		.values({ organizationId, jobSourceId: source.id, trigger })
		.returning({ id: discoveryRun.id });
	if (!run) throw new Error("The run could not be recorded.");
	await db
		.update(jobSource)
		.set(trigger === "scheduled" ? { lastScheduledRunAt: sql`now()` } : { lastRunAt: sql`now()` })
		.where(and(eq(jobSource.id, source.id), eq(jobSource.organizationId, organizationId)));
	return { runId: run.id, source };
}

/** What the model is shown of a job: plain text only (the stored description is sanitized HTML). */
function toAiJob(row: {
	id: string;
	title: string;
	company: string;
	location: string | null;
	remote: string | null;
	descriptionHtml: string;
}): AiMatchJob {
	return {
		id: row.id,
		title: row.title,
		company: row.company,
		location: row.location,
		remote: row.remote,
		description: descriptionToText(row.descriptionHtml, AI_DESCRIPTION_CHARS),
	};
}

/**
 * The AI step: the best `min(ai_top_n, plan cap)` new jobs of this run by local score go to the model, one call each,
 * a few at a time. `aiMatched` counts the calls made, so it can never be more than the jobs sent. A job whose answer
 * does not validate keeps a null `ai_score`. When the matcher says to skip, or the allowance runs out, or the provider
 * fails, the step stops and the reason is returned; local scores stay and the run still succeeds.
 */
async function runAiStep(input: {
	runId: string;
	organizationId: string;
	source: typeof jobSource.$inferSelect;
	newJobs: { id: string; localScore: number }[];
	ai: AiMatcher | undefined;
	planCap: number;
	profile: ScoringProfile;
}): Promise<{ aiPlanned: number; aiMatched: number; aiSkippedReason: AiSkippedReason | null }> {
	const budget = aiCallBudget(input.source.aiTopN, input.planCap);
	if (budget === 0 || input.newJobs.length === 0) return { aiPlanned: 0, aiMatched: 0, aiSkippedReason: null };
	if (!input.ai) return { aiPlanned: 0, aiMatched: 0, aiSkippedReason: "no_platform_ai" };
	const skip = await input.ai.check();
	if (skip) return { aiPlanned: 0, aiMatched: 0, aiSkippedReason: skip };

	const top = selectTopN(input.newJobs, budget);
	const aiPlanned = top.length;
	// The database refuses more matched than planned (a CHECK), so the planned count is written first.
	await db
		.update(discoveryRun)
		.set({ aiPlanned })
		.where(and(eq(discoveryRun.id, input.runId), eq(discoveryRun.organizationId, input.organizationId)));
	const rows = await db
		.select({
			id: discoveredJob.id,
			title: discoveredJob.title,
			company: discoveredJob.company,
			location: discoveredJob.location,
			remote: discoveredJob.remote,
			descriptionHtml: discoveredJob.descriptionHtml,
		})
		.from(discoveredJob)
		.where(
			and(
				eq(discoveredJob.organizationId, input.organizationId),
				inArray(
					discoveredJob.id,
					top.map((job) => job.id),
				),
			),
		);
	// Keep the best-first order so a stop spares the weaker jobs, not the stronger ones.
	const order = new Map(top.map((job, index) => [job.id, index]));
	rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

	let aiMatched = 0;
	let stopped: AiSkippedReason | null = null;
	const ai = input.ai;
	await mapWithConcurrency(rows, AI_CONCURRENCY, async (row) => {
		if (stopped) return;
		try {
			const result = await ai.match(toAiJob(row), input.profile);
			aiMatched++;
			if (result.output) {
				await db
					.update(discoveredJob)
					.set({ aiScore: result.output.score, aiSummary: result.output.summary })
					.where(and(eq(discoveredJob.id, row.id), eq(discoveredJob.organizationId, input.organizationId)));
			}
			await db
				.update(discoveryRun)
				.set({ aiMatched })
				.where(and(eq(discoveryRun.id, input.runId), eq(discoveryRun.organizationId, input.organizationId)));
		} catch (error) {
			// Nothing was called when the allowance ran out. Any other failure ends the step too: the provider is down or
			// misbehaving, and a retry loop would cost more than it earns. The error text is never stored.
			stopped ??= error instanceof AiQuotaStop ? "quota_exhausted" : "provider_error";
		}
	});
	return { aiPlanned, aiMatched, aiSkippedReason: stopped };
}

/**
 * Carries out a run recorded by `beginDiscovery`, inside the caller's organization scope: fetch every board (five at a
 * time), normalize, de-dupe in the run, score locally, insert what the database has not seen, send the best of the new
 * jobs to the AI step, and record the run with its counts. The run row shows progress while it works.
 *
 * A dismissed or accepted job is a row that stays, so the unique key refuses it again and it counts as a duplicate
 * (GTM-PLAN G2).
 */
export async function executeDiscovery(begun: BegunRun, options: RunDiscoveryOptions = {}): Promise<RunSummary> {
	const organizationId = requireOrgId();
	const { source, runId } = begun;

	// A stored list that no longer validates (hand edited row) is skipped board by board, not trusted.
	const parsed = boardListSchema.safeParse(source.boards);
	const boards: BoardRef[] = parsed.success ? parsed.data : [];
	const loadBoard = options.loadBoard ?? ((ref: BoardRef) => fetchBoard(ref, options.http));
	const progress = (values: Partial<typeof discoveryRun.$inferInsert>) =>
		db
			.update(discoveryRun)
			.set(values)
			.where(and(eq(discoveryRun.id, runId), eq(discoveryRun.organizationId, organizationId)));

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
		await progress({ fetched });

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
			firstSeenRunId: runId,
		}));

		const newJobs: { id: string; localScore: number }[] = [];
		for (let start = 0; start < rows.length; start += INSERT_BATCH) {
			const created = await db
				.insert(discoveredJob)
				.values(rows.slice(start, start + INSERT_BATCH))
				.onConflictDoNothing({
					target: [discoveredJob.organizationId, discoveredJob.userId, discoveredJob.source, discoveredJob.externalId],
				})
				.returning({ id: discoveredJob.id, localScore: discoveredJob.localScore });
			newJobs.push(...created);
		}
		const inserted = newJobs.length;
		duplicate += rows.length - inserted;
		await progress({ new: inserted, duplicate, scored: rows.length });

		const ai = await runAiStep({
			runId,
			organizationId,
			source,
			newJobs,
			ai: options.ai,
			planCap: options.aiPlanCap ?? 0,
			profile,
		});

		// Every board failed: the run failed. Some failed: partial (G1). None: succeeded. A source with no boards succeeds.
		const status = errors.length === 0 ? "succeeded" : errors.length === boards.length ? "failed" : "partial";
		const summary: RunSummary = {
			runId,
			status,
			fetched,
			new: inserted,
			duplicate,
			scored: rows.length,
			aiMatched: ai.aiMatched,
			aiPlanned: ai.aiPlanned,
			aiSkippedReason: ai.aiSkippedReason,
			errors,
		};
		await progress({
			status,
			finishedAt: new Date(),
			fetched,
			new: inserted,
			duplicate,
			scored: rows.length,
			aiMatched: ai.aiMatched,
			aiPlanned: ai.aiPlanned,
			aiSkippedReason: ai.aiSkippedReason,
			errors,
		});
		return summary;
	} catch (error) {
		// Close the run so it does not stay "running" forever; the reason is a fixed word, never the error text.
		await progress({
			status: "failed",
			finishedAt: new Date(),
			errors: [{ code: "internal", reason: "The run stopped unexpectedly." }],
		}).catch(() => {});
		throw error;
	}
}

/** Records and carries out one run in the caller's organization scope (call it inside `withOrgContext`). */
export async function runDiscovery(jobSourceId: string, options: RunDiscoveryOptions = {}): Promise<RunSummary> {
	return executeDiscovery(await beginDiscovery(jobSourceId, options), options);
}

/** For callers that have no scope yet: opens the organization's scope, then runs. */
export function runDiscoveryInOrg(organizationId: string, jobSourceId: string, options?: RunDiscoveryOptions) {
	return withOrgContext(organizationId, () => runDiscovery(jobSourceId, options));
}
