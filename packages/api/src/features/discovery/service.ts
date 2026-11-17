import type {
	acceptResultSchema,
	jobSchema,
	runSchema,
	sourceCreateSchema,
	sourceSchema,
	sourceUpdateSchema,
} from "./schemas";
import type z from "zod";
import { getEntitlements } from "@careeros/billing";
import {
	beginDiscovery,
	descriptionToText,
	DiscoveryError,
	executeDiscovery,
	nextRunAfter,
} from "@careeros/job-discovery";
import { captureOrgScope, requireOrgId } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { application, discoveredJob, discoveryRun, jobSource } from "@reactive-resume/db/schema";
import { applicationService } from "../applications/service";
import { createPlatformMatcher } from "./ai-match";

/** `runNow` may start one run per automation in this many minutes (P4-T01 requirement 8). Manual runs only. */
export const RUN_NOW_COOLDOWN_MINUTES = 10;

/** Automations one user may keep in one organization (Q228). */
export const MAX_SOURCES_PER_USER = 20;

/** Runs the history shows per automation. */
export const RUN_HISTORY_LIMIT = 20;

type Source = z.infer<typeof sourceSchema>;
type Job = z.infer<typeof jobSchema>;
type Run = z.infer<typeof runSchema>;
type AcceptResult = z.infer<typeof acceptResultSchema>;

/** Rows are the caller's own: this organization (also enforced by row-level security) and this user. */
const ownSource = (userId: string, id?: string) =>
	and(
		eq(jobSource.organizationId, requireOrgId()),
		eq(jobSource.userId, userId),
		id ? eq(jobSource.id, id) : undefined,
	);
const ownJob = (userId: string, id?: string) =>
	and(
		eq(discoveredJob.organizationId, requireOrgId()),
		eq(discoveredJob.userId, userId),
		id ? eq(discoveredJob.id, id) : undefined,
	);

const notFound = (what: string) => new ORPCError("NOT_FOUND", { message: `${what} was not found.` });

/** The run as the API shows it. A run in progress shows the counts so far. */
function toRun(row: typeof discoveryRun.$inferSelect): Run {
	return {
		runId: row.id,
		jobSourceId: row.jobSourceId,
		trigger: row.trigger,
		status: row.status,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		fetched: row.fetched,
		new: row.new,
		duplicate: row.duplicate,
		scored: row.scored,
		aiMatched: row.aiMatched,
		aiPlanned: row.aiPlanned,
		aiSkippedReason: row.aiSkippedReason,
		errors: row.errors,
	};
}

export const discoveryService = {
	sources: {
		async list(userId: string): Promise<Source[]> {
			return await db
				.select()
				.from(jobSource)
				.where(ownSource(userId))
				.orderBy(desc(jobSource.createdAt), jobSource.id);
		},

		async create(userId: string, input: z.infer<typeof sourceCreateSchema>): Promise<Source> {
			const organizationId = requireOrgId();
			// The cap is checked and the row inserted under one advisory lock per user and organization, so two
			// parallel creates cannot both pass the check (Q228).
			return await db.transaction(async (tx) => {
				await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`job_source:${organizationId}:${userId}`}))`);
				const [existing] = await tx
					.select({ total: count() })
					.from(jobSource)
					.where(and(eq(jobSource.organizationId, organizationId), eq(jobSource.userId, userId)));
				if ((existing?.total ?? 0) >= MAX_SOURCES_PER_USER) {
					throw new ORPCError("BAD_REQUEST", {
						message: `You can have at most ${MAX_SOURCES_PER_USER} automations. Delete one to add another.`,
						data: { code: "AUTOMATION_LIMIT_REACHED", limit: MAX_SOURCES_PER_USER },
					});
				}
				const [row] = await tx
					.insert(jobSource)
					// CAREEROS (P4-T02): the next scheduled run is set on create (paused has none).
					.values({ ...input, organizationId, userId, nextRunAt: nextRunAfter(input.schedule, new Date()) })
					.returning();
				if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR");
				return row;
			});
		},

		async update(userId: string, input: z.infer<typeof sourceUpdateSchema>): Promise<Source> {
			const { id, ...changes } = input;
			// CAREEROS (P4-T02): `next_run_at` follows the schedule. Pausing clears it; a changed schedule (or a source that
			// has none, such as one resumed from paused) gets a fresh one from now.
			let nextRunAt: Date | null | undefined;
			if (changes.schedule !== undefined) {
				const [existing] = await db
					.select({ schedule: jobSource.schedule, nextRunAt: jobSource.nextRunAt })
					.from(jobSource)
					.where(ownSource(userId, id))
					.limit(1);
				if (!existing) throw notFound("The automation");
				if (changes.schedule === "paused") nextRunAt = null;
				else if (existing.schedule !== changes.schedule || !existing.nextRunAt)
					nextRunAt = nextRunAfter(changes.schedule, new Date());
			}
			// An empty patch still touches updated_at, and tells a missing row from a no-op.
			const [row] = await db
				.update(jobSource)
				.set({ ...changes, ...(nextRunAt === undefined ? {} : { nextRunAt }), updatedAt: new Date() })
				.where(ownSource(userId, id))
				.returning();
			if (!row) throw notFound("The automation");
			return row;
		},

		async delete(userId: string, id: string): Promise<void> {
			const removed = await db.delete(jobSource).where(ownSource(userId, id)).returning({ id: jobSource.id });
			if (removed.length === 0) throw notFound("The automation");
		},
	},

	/**
	 * Starts a run now and answers as soon as it is recorded as `running`; the run carries on in the background on this
	 * server and its row shows the progress (`runs.list`). A server restart kills it: the scheduler's sweep marks a run
	 * still `running` after 15 minutes as failed. The 10-minute limit is claimed with one conditional UPDATE on
	 * `last_run_at` in database time, so two requests cannot both pass it and it holds across server processes. Only
	 * manual runs set `last_run_at`; scheduled runs set `last_scheduled_run_at` and never block this.
	 */
	async runNow(userId: string, id: string) {
		const organizationId = requireOrgId();
		const claimed = await db
			.update(jobSource)
			.set({ lastRunAt: sql`now()` })
			.where(
				and(
					ownSource(userId, id),
					or(
						isNull(jobSource.lastRunAt),
						lt(jobSource.lastRunAt, sql`now() - make_interval(mins => ${RUN_NOW_COOLDOWN_MINUTES})`),
					),
				),
			)
			.returning({ id: jobSource.id });
		if (claimed.length === 0) {
			const [existing] = await db.select({ id: jobSource.id }).from(jobSource).where(ownSource(userId, id)).limit(1);
			if (!existing) throw notFound("The automation");
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `An automation can run now once every ${RUN_NOW_COOLDOWN_MINUTES} minutes.`,
			});
		}
		let begun;
		try {
			begun = await beginDiscovery(id, { trigger: "manual" });
		} catch (error) {
			if (error instanceof DiscoveryError) throw notFound("The automation");
			throw error;
		}
		const entitlements = await getEntitlements(organizationId);
		// The request scope ends when this handler returns; the run continues in a scope of its own for this organization.
		const inScope = captureOrgScope();
		const options = {
			trigger: "manual" as const,
			aiPlanCap: entitlements.discoveryAiTopN,
			ai: createPlatformMatcher({ organizationId, userId: begun.source.userId }),
		};
		void inScope(() => executeDiscovery(begun, options)).catch((error: unknown) => {
			// `executeDiscovery` has already closed the run as failed; the error text is not logged (it can quote a board).
			console.error(
				`[discovery] Background run ${begun.runId} failed for organization ${organizationId}`,
				error instanceof Error ? error.name : "error",
			);
		});
		return {
			runId: begun.runId,
			status: "running" as const,
			fetched: 0,
			new: 0,
			duplicate: 0,
			scored: 0,
			aiMatched: 0,
			aiPlanned: 0,
			aiSkippedReason: null,
			errors: [],
		};
	},

	runs: {
		/** The latest runs of one of the caller's automations, newest first. */
		async list(userId: string, jobSourceId: string): Promise<Run[]> {
			const [source] = await db
				.select({ id: jobSource.id })
				.from(jobSource)
				.where(ownSource(userId, jobSourceId))
				.limit(1);
			if (!source) throw notFound("The automation");
			const rows = await db
				.select()
				.from(discoveryRun)
				.where(and(eq(discoveryRun.organizationId, requireOrgId()), eq(discoveryRun.jobSourceId, jobSourceId)))
				.orderBy(desc(discoveryRun.startedAt), discoveryRun.id)
				.limit(RUN_HISTORY_LIMIT);
			return rows.map(toRun);
		},
	},

	jobs: {
		/**
		 * The review queue: best match first, that is the AI score, then the local score, then the newest. A job without an
		 * AI score sorts after those that have one.
		 */
		async list(
			userId: string,
			input: { status?: Job["status"] | undefined; jobSourceId?: string | undefined; limit: number; offset: number },
		) {
			return await db
				.select()
				.from(discoveredJob)
				.where(
					and(
						ownJob(userId),
						input.status ? eq(discoveredJob.status, input.status) : undefined,
						input.jobSourceId ? eq(discoveredJob.jobSourceId, input.jobSourceId) : undefined,
					),
				)
				.orderBy(
					sql`${discoveredJob.aiScore} desc nulls last`,
					desc(discoveredJob.localScore),
					desc(discoveredJob.createdAt),
					asc(discoveredJob.id),
				)
				.limit(input.limit)
				.offset(input.offset);
		},

		async get(userId: string, id: string): Promise<Job> {
			const [job] = await db.select().from(discoveredJob).where(ownJob(userId, id)).limit(1);
			if (!job) throw notFound("The job");
			return job;
		},

		/** Dismissal is a status, never a delete: the row is what keeps the posting from coming back (G2). */
		async dismiss(userId: string, id: string): Promise<Job> {
			const [updated] = await db
				.update(discoveredJob)
				.set({ status: "dismissed", updatedAt: new Date() })
				.where(and(ownJob(userId, id), eq(discoveredJob.status, "new")))
				.returning();
			if (updated) return updated;
			const [existing] = await db.select().from(discoveredJob).where(ownJob(userId, id)).limit(1);
			if (!existing) throw notFound("The job");
			if (existing.status === "dismissed") return existing;
			throw new ORPCError("CONFLICT", { message: "This job was already accepted." });
		},

		/**
		 * Accepts a job into the tracker: creates one application (first stage, company, role, location, link, the
		 * description as plain text, source `discovery`, the board as a tag), marks the job `accepted` and stores the new
		 * application's id. Idempotent: an accepted job answers with its application and creates nothing. A dismissed job
		 * can be accepted. One session-level advisory lock per job (held on the request's own connection) serializes two
		 * simultaneous accepts; the second finds the first's result. If a crash left an application that was created but
		 * never linked, the next accept finds it by its link and adopts it instead of adding a second.
		 */
		async accept(userId: string, id: string): Promise<AcceptResult> {
			const organizationId = requireOrgId();
			const lockKey = `discovered_job:accept:${organizationId}:${id}`;
			await db.execute(sql`select pg_advisory_lock(hashtext(${lockKey}))`);
			try {
				const [job] = await db.select().from(discoveredJob).where(ownJob(userId, id)).limit(1);
				if (!job) throw notFound("The job");
				if (job.status === "accepted" && job.applicationId) return { job, applicationId: job.applicationId };

				const [adopted] = await db
					.select({ id: application.id })
					.from(application)
					.where(
						and(
							eq(application.organizationId, organizationId),
							eq(application.userId, userId),
							eq(application.source, "discovery"),
							eq(application.sourceUrl, job.url),
						),
					)
					.orderBy(asc(application.createdAt))
					.limit(1);
				const applicationId =
					adopted?.id ??
					(await applicationService.create({
						userId,
						company: job.company,
						role: job.title,
						location: job.location,
						sourceUrl: job.url,
						jobDescription: descriptionToText(job.descriptionHtml),
						source: "discovery",
						tags: [job.boardToken],
						status: "saved",
					}));
				const [accepted] = await db
					.update(discoveredJob)
					.set({ status: "accepted", applicationId, acceptedAt: new Date(), updatedAt: new Date() })
					.where(ownJob(userId, id))
					.returning();
				if (!accepted) throw notFound("The job");
				return { job: accepted, applicationId };
			} finally {
				await db.execute(sql`select pg_advisory_unlock(hashtext(${lockKey}))`).catch(() => {});
			}
		},
	},

	/** The caller's automations, their runs and found jobs in the active organization, for the account export (P4-T02). */
	async exportData(userId: string) {
		const sources = await db.select().from(jobSource).where(eq(jobSource.userId, userId));
		const sourceIds = sources.map((source) => source.id);
		const runs =
			sourceIds.length === 0
				? []
				: await db.select().from(discoveryRun).where(inArray(discoveryRun.jobSourceId, sourceIds));
		const jobs = await db.select().from(discoveredJob).where(eq(discoveredJob.userId, userId));
		return {
			// The tenant column and the owner are not part of the export.
			automations: sources.map(({ organizationId: _organizationId, userId: _userId, ...source }) => source),
			runs: runs.map(({ organizationId: _organizationId, ...run }) => run),
			jobs: jobs.map(({ organizationId: _organizationId, userId: _userId, ...job }) => job),
		};
	},
};
