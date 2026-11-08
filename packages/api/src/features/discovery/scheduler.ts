import type { getModel } from "../ai/service";
import type { BoardHttpOptions, BoardLoader } from "@careeros/job-discovery";
import { getEntitlements } from "@careeros/billing";
import { mapWithConcurrency, nextRunAfter, runDiscovery, STALE_RUN_MINUTES } from "@careeros/job-discovery";
import { withOrgContext } from "@careeros/tenancy";
import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { discoveryRun, jobSource } from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";
import { isCareerSchedulingEnabled } from "../career/runner";
import { createPlatformMatcher } from "./ai-match";

// CAREEROS (P4-T02, GTM-PLAN G3): discovery runs on each member's daily or weekly schedule. The tick has no organization
// of its own and row-level security hides every discovery row from it, so it asks the database (a definer function,
// P1-T07's pattern) for the ids of due sources and does all other reading and writing inside `withOrgContext`, one source
// at a time. A source is claimed by one conditional UPDATE that moves `next_run_at` on, so two server instances never run
// the same source. A failure in one source is logged and does not stop the others.

/** Sources a single tick may take. The tick is bounded; what does not fit waits for the next one. */
export const MAX_SOURCES_PER_TICK = 10;
/** Sources run at a time within one tick (each holds one database connection while it runs). */
export const SOURCE_CONCURRENCY = 2;

/** Whether discovery runs on a schedule on this server: the career scheduler is on and the kill switch is not set. */
export const isDiscoverySchedulingEnabled = () => !env.FLAG_DISABLE_DISCOVERY_SCHEDULER && isCareerSchedulingEnabled();

export type SchedulerOptions = {
	now?: Date;
	maxSources?: number;
	/** Stop starting new sources after this many milliseconds (a cron invocation has a time limit). */
	budgetMs?: number;
	/** Fixed jitter source for tests; returns a number in [0, 1). */
	random?: () => number;
	/** Tests replace these so no run reaches a real job board or the real provider. */
	loadBoard?: BoardLoader;
	http?: BoardHttpOptions;
	buildModel?: typeof getModel;
	/** Runs the sweep and the due sources even when the scheduler is switched off (tests). */
	ignoreKillSwitch?: boolean;
};

export type SchedulerResult = {
	/** Sources this tick took and carried out. */
	ran: number;
	/** Sources it claimed but did not run: the organization is suspended or lacks the feature. */
	skipped: number;
	/** Sources whose run threw. */
	failed: number;
	/** Runs the stale-run sweep marked `failed`. */
	swept: number;
};

type DueRow = { id: string; organization_id: string };

/** Marks the organization's runs that stayed `running` past the limit as `failed`. Runs inside `withOrgContext`. */
async function sweepOrganization(organizationId: string): Promise<number> {
	const swept = await db
		.update(discoveryRun)
		.set({
			status: "failed",
			finishedAt: new Date(),
			errors: sql`${discoveryRun.errors} || ${JSON.stringify([{ code: "stale", reason: "The run did not finish. The server may have restarted." }])}::jsonb`,
		})
		.where(
			and(
				eq(discoveryRun.organizationId, organizationId),
				eq(discoveryRun.status, "running"),
				sql`${discoveryRun.startedAt} <= now() - make_interval(mins => ${STALE_RUN_MINUTES})`,
			),
		)
		.returning({ id: discoveryRun.id });
	return swept.length;
}

/**
 * A server restart kills a background run and leaves it `running`. This fails every run still `running` after 15
 * minutes, so the history is honest and a new run is not blocked by a ghost.
 */
export async function sweepStaleDiscoveryRuns(now: Date = new Date()): Promise<number> {
	const { rows } = await db.execute<{ organization_id: string }>(
		sql`select careeros_orgs_with_stale_discovery_runs(${now.toISOString()}::timestamptz, ${STALE_RUN_MINUTES}::int) as organization_id`,
	);
	let swept = 0;
	for (const organizationId of new Set(rows.map((row) => row.organization_id))) {
		try {
			swept += await withOrgContext(organizationId, () => sweepOrganization(organizationId));
		} catch (error) {
			console.error(`[discovery] Stale run sweep failed for organization ${organizationId}`, error);
		}
	}
	return swept;
}

/**
 * Claims one source: reads it, then moves `next_run_at` on with a conditional UPDATE that only matches while the source
 * is still due. Of two servers racing for the same source exactly one UPDATE matches. The next run is a period from the
 * run start plus jitter. Inside `withOrgContext`. Null when the source is gone, paused, not yet due, or taken.
 */
async function claim(sourceId: string, organizationId: string, now: Date, random: () => number) {
	const [source] = await db
		.select({ schedule: jobSource.schedule, nextRunAt: jobSource.nextRunAt })
		.from(jobSource)
		.where(and(eq(jobSource.id, sourceId), eq(jobSource.organizationId, organizationId)))
		.limit(1);
	if (!source?.nextRunAt || source.schedule === "paused" || source.nextRunAt > now) return null;
	const next = nextRunAfter(source.schedule, now, random);
	const claimed = await db
		.update(jobSource)
		.set({ nextRunAt: next })
		.where(
			and(
				eq(jobSource.id, sourceId),
				eq(jobSource.organizationId, organizationId),
				eq(jobSource.schedule, source.schedule),
				// Due is checked again by the UPDATE itself: a racing server's UPDATE re-reads the row after the first one
				// commits, finds `next_run_at` in the future and matches nothing. (Not an equality on the value read: the
				// column holds microseconds and a JavaScript date does not.)
				lte(jobSource.nextRunAt, now),
			),
		)
		.returning({ id: jobSource.id, userId: jobSource.userId });
	return claimed[0] ?? null;
}

function processSource(row: DueRow, now: Date, options: SchedulerOptions): Promise<"ran" | "skipped" | "lost"> {
	return withOrgContext(row.organization_id, async () => {
		const claimed = await claim(row.id, row.organization_id, now, options.random ?? Math.random);
		if (!claimed) return "lost";
		// Suspended organizations and plans without discovery are refused at run time, not only when the source was made.
		const entitlements = await getEntitlements(row.organization_id);
		if (entitlements.readOnly || !entitlements.features.job_discovery) return "skipped";
		await runDiscovery(row.id, {
			trigger: "scheduled",
			...(options.loadBoard ? { loadBoard: options.loadBoard } : {}),
			...(options.http ? { http: options.http } : {}),
			aiPlanCap: entitlements.discoveryAiTopN,
			ai: createPlatformMatcher({
				organizationId: row.organization_id,
				userId: claimed.userId,
				...(options.buildModel ? { buildModel: options.buildModel } : {}),
			}),
		});
		return "ran";
	});
}

/** One bounded scheduler tick: sweep stale runs, then run the sources that are due. */
export async function runDiscoveryJobs(options: SchedulerOptions = {}): Promise<SchedulerResult> {
	const result: SchedulerResult = { ran: 0, skipped: 0, failed: 0, swept: 0 };
	if (!options.ignoreKillSwitch && !isDiscoverySchedulingEnabled()) return result;
	const now = options.now ?? new Date();
	const startedAt = Date.now();

	result.swept = await sweepStaleDiscoveryRuns(now).catch((error: unknown) => {
		console.error("[discovery] Stale run sweep failed", error);
		return 0;
	});

	const { rows } = await db.execute<DueRow>(
		sql`select id, organization_id from careeros_due_discovery_sources(${now.toISOString()}::timestamptz, ${options.maxSources ?? MAX_SOURCES_PER_TICK}::int)`,
	);
	await mapWithConcurrency(rows, SOURCE_CONCURRENCY, async (row) => {
		if (options.budgetMs !== undefined && Date.now() - startedAt > options.budgetMs) return;
		try {
			const outcome = await processSource(row, now, options);
			if (outcome === "ran") result.ran++;
			else if (outcome === "skipped") result.skipped++;
		} catch (error) {
			result.failed++;
			// The ids are enough to find it; the error text can quote a board response, so it is not logged here.
			console.error(
				`[discovery] Scheduled run of source ${row.id} failed for organization ${row.organization_id}`,
				error instanceof Error ? error.name : "error",
			);
		}
	});
	return result;
}
