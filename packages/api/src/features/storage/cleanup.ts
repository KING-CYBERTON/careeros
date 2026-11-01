import type { DbOrTx } from "@reactive-resume/db/client";
// CAREEROS: the cleanup queue is per organization (P1-T09)
import { currentOrgId, requireOrgId, withOrgContext } from "@careeros/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { generateId } from "@reactive-resume/utils/string";
import { getStorageService } from "./service";

// A failed attempt gets its own bounded retry with capped backoff. The row and last error stay durable while it runs.
const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const ENQUEUE_CHUNK = 1_000;

type StorageDeleteOutcome =
	| { status: "deleted"; removed: number }
	| { status: "missing"; removed: 0 }
	| { status: "partial"; removed: number; remaining: number }
	| { status: "failed"; error: string };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "Storage cleanup failed.");

const matchesPrefix = (storageKey: string, candidate: string) =>
	candidate === storageKey || candidate.startsWith(`${storageKey}/`);

/**
 * Deletes everything under a document or account prefix and verifies it is gone. A missing prefix completes without
 * work; a genuinely failed or partial delete keeps its target for a later retry.
 */
async function deleteStoragePrefix(storageKey: string): Promise<StorageDeleteOutcome> {
	try {
		const storage = getStorageService();
		const before = (await storage.list(storageKey)).filter((candidate) => matchesPrefix(storageKey, candidate));
		if (before.length === 0) return { status: "missing", removed: 0 };
		await storage.delete(storageKey);
		const remaining = (await storage.list(storageKey)).filter((candidate) => matchesPrefix(storageKey, candidate));
		if (remaining.length === 0) return { status: "deleted", removed: before.length };
		return { status: "partial", removed: before.length - remaining.length, remaining: remaining.length };
	} catch (error) {
		return { status: "failed", error: errorMessage(error) };
	}
}

/** Writes durable cleanup rows in the same transaction that deletes their document rows. */
export async function enqueueStorageCleanup(tx: DbOrTx, ownerId: string, storageKeys: readonly string[]) {
	// CAREEROS: the work belongs to the organization of the delete that wrote it (P1-T09).
	const organizationId = requireOrgId();
	const unique = [...new Set(storageKeys)];
	for (let start = 0; start < unique.length; start += ENQUEUE_CHUNK) {
		await tx
			.insert(schema.storageCleanupJob)
			.values(unique.slice(start, start + ENQUEUE_CHUNK).map((storageKey) => ({ organizationId, ownerId, storageKey })))
			.onConflictDoNothing();
	}
}

type RunStorageCleanupInput = {
	ownerId?: string;
	/** Restrict an immediate post-delete pass to the keys it just enqueued. */
	storageKeys?: readonly string[];
	limit?: number;
};

export type StorageCleanupSummary = {
	completed: number;
	missing: number;
	failed: number;
	partial: number;
	abandoned: number;
};

const emptySummary = (): StorageCleanupSummary => ({ completed: 0, missing: 0, failed: 0, partial: 0, abandoned: 0 });

/** Sanitized signal for every runtime. Never logs storage keys, owner IDs or provider errors. */
export function reportStorageCleanupSummary(summary: StorageCleanupSummary) {
	if (summary.failed === 0 && summary.partial === 0 && summary.abandoned === 0) return;
	console.warn(
		"[storage-cleanup] Cleanup work remains. See docs/contributing/storage-cleanup.mdx for inspection and requeue.",
		{
			completed: summary.completed,
			missing: summary.missing,
			failed: summary.failed,
			partial: summary.partial,
			abandoned: summary.abandoned,
		},
	);
}

/**
 * Claims one specific due job inside its organization, with a new fence token for every attempt. `null` when another
 * worker took it or it is no longer due.
 */
function claimJob(organizationId: string, id: string) {
	const now = new Date();
	return withOrgContext(organizationId, () =>
		db.transaction(async (tx) => {
			const [job] = await tx
				.select()
				.from(schema.storageCleanupJob)
				.where(
					and(
						eq(schema.storageCleanupJob.id, id),
						eq(schema.storageCleanupJob.status, "pending"),
						sql`${schema.storageCleanupJob.nextAttemptAt} <= ${now}`,
					),
				)
				.limit(1)
				.for("update", { skipLocked: true });
			if (!job) return null;
			const [claimed] = await tx
				.update(schema.storageCleanupJob)
				.set({
					attempts: job.attempts + 1,
					claimToken: generateId(),
					nextAttemptAt: new Date(now.getTime() + LEASE_MS),
				})
				.where(eq(schema.storageCleanupJob.id, job.id))
				.returning();
			return claimed ?? null;
		}),
	);
}

/**
 * CAREEROS (P1-T09, D9 pattern): the worker has no organization and row-level security hides every job from it. A
 * definer function lists the due `(id, organization_id)` pairs, then each job is claimed, executed and acknowledged
 * inside `withOrgContext` for its own organization, keeping the claim-token fencing. A job (or organization) that
 * fails is counted and does not stop the others. Called inside a request, only that request's organization is touched
 * (an organization is never switched mid-scope); the scheduler picks up the rest.
 */
export async function runStorageCleanup(input: RunStorageCleanupInput = {}): Promise<StorageCleanupSummary> {
	const limit = input.limit ?? 200;
	const summary = emptySummary();
	if (limit <= 0) return summary;

	// An array parameter would expand to a tuple, so the keys are spelled as an ARRAY[...] of parameters.
	const keys = input.storageKeys
		? sql`array[${sql.join(
				[...new Set(input.storageKeys)].map((key) => sql`${key}`),
				sql`, `,
			)}]::text[]`
		: sql`null::text[]`;
	const { rows: due } = await db.execute<{ id: string; organization_id: string }>(
		sql`select id, organization_id from careeros_due_storage_cleanup(${new Date()}::timestamptz, ${limit}, ${input.ownerId ?? null}, ${keys}, ${currentOrgId() ?? null})`,
	);
	for (const { id, organization_id: organizationId } of due) {
		try {
			await processJob(organizationId, id, summary);
		} catch (error) {
			summary.failed += 1;
			console.error(`[storage-cleanup] Job failed for organization ${organizationId}`, error);
		}
	}
	return summary;
}

async function processJob(organizationId: string, id: string, summary: StorageCleanupSummary) {
	const job = await claimJob(organizationId, id);
	if (!job?.claimToken) return;
	const claim = and(eq(schema.storageCleanupJob.id, job.id), eq(schema.storageCleanupJob.claimToken, job.claimToken));
	// Storage work runs outside any database scope so a slow delete holds no connection.
	const outcome = await deleteStoragePrefix(job.storageKey);
	if (outcome.status === "deleted" || outcome.status === "missing") {
		const acknowledged = await withOrgContext(organizationId, () =>
			db.delete(schema.storageCleanupJob).where(claim).returning({ id: schema.storageCleanupJob.id }),
		);
		if (acknowledged.length === 0) return;
		if (outcome.status === "deleted") summary.completed += 1;
		else summary.missing += 1;
		return;
	}

	const abandoned = job.attempts >= MAX_ATTEMPTS;
	const retryDelay = Math.min(RETRY_BASE_MS * 2 ** (job.attempts - 1), RETRY_MAX_MS);
	const acknowledged = await withOrgContext(organizationId, () =>
		db
			.update(schema.storageCleanupJob)
			.set({
				status: abandoned ? "abandoned" : "pending",
				claimToken: null,
				nextAttemptAt: new Date(Date.now() + (abandoned ? 0 : retryDelay)),
				lastError:
					outcome.status === "partial"
						? `Partial storage delete: ${outcome.remaining} object(s) remain.`
						: outcome.error,
			})
			.where(claim)
			.returning({ id: schema.storageCleanupJob.id }),
	);
	if (acknowledged.length === 0) return;
	if (outcome.status === "partial") summary.partial += 1;
	else summary.failed += 1;
	if (abandoned) summary.abandoned += 1;
}
