import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { user } from "./auth";

// CAREEROS (P3-T07, phase plan D6): the Super Admin console's own tables. All three are GLOBAL and the app role has no
// privilege on any of them: every read and write goes through a SECURITY DEFINER function (see the migration), which
// checks that the caller is a platform admin and writes the audit row in the same transaction. They carry no foreign
// key to `organization` or `user` on purpose, so deleting an organization or a person never changes or deletes this
// history, and nothing here uses ON DELETE CASCADE except the dismissals of a deleted user.

export const ANNOUNCEMENT_SEVERITIES = ["info", "warning"] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

/** The plain-text limits the migration's CHECK constraints enforce. */
export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 1000;

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

/**
 * A banner the platform shows to members. Global: the optional `plan_id` and `organization_id` only narrow who sees it
 * (both null means everyone). `organization_id` is deliberately not a foreign key (an announcement for a deleted
 * organization simply matches nobody). Body is plain text.
 */
export const announcement = pg.pgTable(
	"announcement",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.default(sql`gen_random_uuid()::text`),
		title: pg.text("title").notNull(),
		body: pg.text("body").notNull(),
		severity: pg.text("severity").notNull().default("info"),
		startsAt: pg.timestamp("starts_at", { withTimezone: true }).notNull(),
		endsAt: pg.timestamp("ends_at", { withTimezone: true }).notNull(),
		// Not a foreign key, like `organization_id`: the plan table's own down migration must not depend on this one, and
		// `careeros_admin_announcement_save` checks the plan exists. A removed plan simply never matches.
		planId: pg.text("plan_id"),
		organizationId: pg.text("organization_id"),
		createdBy: pg.text("created_by"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		pg.check("announcement_severity_check", sql`${t.severity} in (${list(ANNOUNCEMENT_SEVERITIES)})`),
		pg.check(
			"announcement_title_check",
			sql`char_length(${t.title}) between 1 and ${sql.raw(String(ANNOUNCEMENT_TITLE_MAX))}`,
		),
		pg.check(
			"announcement_body_check",
			sql`char_length(${t.body}) between 1 and ${sql.raw(String(ANNOUNCEMENT_BODY_MAX))}`,
		),
		pg.check("announcement_window_check", sql`${t.endsAt} > ${t.startsAt}`),
		pg.index("announcement_window_idx").on(t.startsAt, t.endsAt),
	],
);

/**
 * A member's dismissal of an announcement, per user. The only row here that follows the user: it goes with the account
 * (ON DELETE CASCADE), because it is the user's own preference and nobody else's history.
 */
export const announcementDismissal = pg.pgTable(
	"announcement_dismissal",
	{
		announcementId: pg
			.text("announcement_id")
			.notNull()
			.references(() => announcement.id),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		dismissedAt: pg.timestamp("dismissed_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		pg.primaryKey({ columns: [t.announcementId, t.userId] }),
		pg.index("announcement_dismissal_user_idx").on(t.userId),
	],
);

export const IMPERSONATION_END_REASONS = ["ended", "expired"] as const;
export type ImpersonationEndReason = (typeof IMPERSONATION_END_REASONS)[number];

/**
 * One support session in which a platform admin acts as a member (phase plan D6). `token_hash` is the SHA-256 of the
 * one-time token that carries the session from the platform host to the member's organization host (the P2-T05
 * pattern: hashed, 60 seconds, redeemed once, bound to the target origin). `session_id` is the Better Auth session the
 * redeem step created. `expires_at` is fixed when the session starts (60 minutes) and is never extended. A row with
 * `ended_at` null and `expires_at` in the future is the only thing that lets an impersonated session through.
 */
export const impersonation = pg.pgTable(
	"impersonation",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.default(sql`gen_random_uuid()::text`),
		impersonatorUserId: pg.text("impersonator_user_id").notNull(),
		targetUserId: pg.text("target_user_id").notNull(),
		organizationId: pg.text("organization_id").notNull(),
		reason: pg.text("reason").notNull(),
		targetOrigin: pg.text("target_origin").notNull(),
		tokenHash: pg.text("token_hash").notNull(),
		tokenExpiresAt: pg.timestamp("token_expires_at", { withTimezone: true }).notNull(),
		redeemedAt: pg.timestamp("redeemed_at", { withTimezone: true }),
		sessionId: pg.text("session_id"),
		startedAt: pg.timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: pg.timestamp("expires_at", { withTimezone: true }).notNull(),
		endedAt: pg.timestamp("ended_at", { withTimezone: true }),
		endReason: pg.text("end_reason"),
	},
	(t) => [
		pg.check("impersonation_end_reason_check", sql`${t.endReason} in (${list(IMPERSONATION_END_REASONS)})`),
		pg.check("impersonation_ended_check", sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
		pg.index("impersonation_session_idx").on(t.sessionId),
		pg.index("impersonation_expires_idx").on(t.expiresAt),
	],
);
