import type { jobSchema, sourceCreateSchema, sourceSchema, sourceUpdateSchema } from "./schemas";
import type z from "zod";
import { DiscoveryError, runDiscovery } from "@careeros/job-discovery";
import { requireOrgId } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { discoveredJob, jobSource } from "@reactive-resume/db/schema";

/** `runNow` may start one run per automation in this many minutes (P4-T01 requirement 8). */
export const RUN_NOW_COOLDOWN_MINUTES = 10;

type Source = z.infer<typeof sourceSchema>;
type Job = z.infer<typeof jobSchema>;

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
			const [row] = await db
				.insert(jobSource)
				.values({ ...input, organizationId: requireOrgId(), userId })
				.returning();
			if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR");
			return row;
		},

		async update(userId: string, input: z.infer<typeof sourceUpdateSchema>): Promise<Source> {
			const { id, ...changes } = input;
			// An empty patch still touches updated_at, and tells a missing row from a no-op.
			const [row] = await db
				.update(jobSource)
				.set({ ...changes, updatedAt: new Date() })
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
	 * Starts a run now. The cooldown is claimed with one conditional UPDATE on `last_run_at` in database time, so two
	 * requests cannot both pass it and it holds across server processes. `runDiscovery` then runs inside the caller's
	 * organization scope.
	 */
	async runNow(userId: string, id: string) {
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
		try {
			return await runDiscovery(id);
		} catch (error) {
			if (error instanceof DiscoveryError) throw notFound("The automation");
			throw error;
		}
	},

	jobs: {
		async list(
			userId: string,
			input: { status?: Job["status"] | undefined; limit: number; offset: number },
		): Promise<Job[]> {
			const rows = await db
				.select()
				.from(discoveredJob)
				.where(and(ownJob(userId), input.status ? eq(discoveredJob.status, input.status) : undefined))
				// Best match first: the AI score once T02 sets one, the local score until then.
				.orderBy(
					desc(sql`coalesce(${discoveredJob.aiScore}, ${discoveredJob.localScore})`),
					desc(discoveredJob.createdAt),
					discoveredJob.id,
				)
				.limit(input.limit)
				.offset(input.offset);
			return rows;
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
	},
};
