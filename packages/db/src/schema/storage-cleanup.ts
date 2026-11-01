import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";

export const STORAGE_CLEANUP_STATUSES = ["pending", "abandoned"] as const;
export type StorageCleanupStatus = (typeof STORAGE_CLEANUP_STATUSES)[number];

/**
 * Durable work left after a document or account is deleted. Work is written in the same transaction as the row delete,
 * then removed only after the storage prefix is verified empty. There is deliberately no user foreign key: deleting an
 * account must not cascade away the erasure targets that account still needs. `claimToken` fences late acknowledgments
 * from a worker whose lease expired.
 *
 * CAREEROS (P1-T09): `organizationId` puts the table under row-level security, and it is deliberately NOT a foreign
 * key to `organization` (like `ownerId`): deleting an organization or an account must not cancel its erasure work.
 * Rows whose owner no longer exists carry the sentinel organization `careeros_orphan` and are processed like any other.
 */
export const storageCleanupJob = pg.pgTable(
	"storage_cleanup_job",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		// CAREEROS: tenant column, no foreign key on purpose (see above).
		organizationId: pg.text("organization_id").notNull(),
		ownerId: pg.text("owner_id").notNull(),
		storageKey: pg.text("storage_key").notNull(),
		status: pg.text("status").$type<StorageCleanupStatus>().notNull().default("pending"),
		attempts: pg.integer("attempts").notNull().default(0),
		claimToken: pg.text("claim_token"),
		nextAttemptAt: pg.timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
		lastError: pg.text("last_error"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		// CAREEROS: organization-led key (P1-T09, D11).
		pg.unique("storage_cleanup_job_owner_key_unique").on(t.organizationId, t.ownerId, t.storageKey),
		pg
			.index("storage_cleanup_job_due_index")
			.on(t.status, t.nextAttemptAt)
			.where(sql`${t.status} = 'pending'`),
		// CAREEROS: organization-led twin of the due index, for the per-organization claim (P1-T09).
		pg
			.index("storage_cleanup_job_org_due_index")
			.on(t.organizationId, t.status, t.nextAttemptAt)
			.where(sql`${t.status} = 'pending'`),
	],
);
