import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";
import { user } from "./auth";
import { organization } from "./organization";

/**
 * CAREEROS (P5-T02, phase plan G6): the Job Clipper's sign-in, as two platform-global tables like Better Auth's own
 * `session` and `verification` tables. Both are read before any session or organization context exists, so neither has
 * row level security; both carry `organization_id` only to say which organization (host) a sign-in belongs to. The
 * application reaches them through the Better Auth device-authorization plugin's adapter and the `careeros-clipper`
 * plugin's endpoints (packages/auth/src/clipper.ts), never from a feature query.
 */

/**
 * The device-authorization plugin's `deviceCode` model (Better Auth 1.7.12), plus two fields of the CareerOS grant:
 * the organization and the host the code was requested on. A code lives 10 minutes and is deleted when it is redeemed,
 * denied or found expired.
 */
export const deviceCode = pg.pgTable(
	"device_code",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		deviceCode: pg.text("device_code").notNull(),
		userCode: pg.text("user_code").notNull(),
		userId: pg.text("user_id").references(() => user.id, { onDelete: "cascade" }),
		expiresAt: pg.timestamp("expires_at", { withTimezone: true }).notNull(),
		status: pg.text("status").notNull(),
		lastPolledAt: pg.timestamp("last_polled_at", { withTimezone: true }),
		pollingInterval: pg.integer("polling_interval"),
		clientId: pg.text("client_id"),
		scope: pg.text("scope"),
		/** The organization the request host resolved to. Never sent by the client. */
		organizationId: pg
			.text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** The normalized host name the code was requested on, for display and the audit trail. */
		requestHost: pg.text("request_host").notNull(),
	},
	(t) => [
		pg.uniqueIndex("device_code_device_code_idx").on(t.deviceCode),
		pg.uniqueIndex("device_code_user_code_idx").on(t.userCode),
		pg.index("device_code_expires_at_idx").on(t.expiresAt),
		pg.index("device_code_user_id_organization_id_idx").on(t.userId, t.organizationId),
	],
);

/**
 * One Job Clipper sign-in: a long random token that works only on the hosts of one organization and only for the
 * clipper's procedure allow-list. Only the SHA-256 of the token is stored, never the token. The row is deleted to
 * revoke it, and by database triggers when the member leaves the organization or the account is banned.
 */
export const clipperToken = pg.pgTable(
	"clipper_token",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		/** Hex SHA-256 of the raw token. */
		tokenHash: pg.text("token_hash").notNull(),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: pg
			.text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** The host the token was issued on. The organization, not this name, decides where it works. */
		host: pg.text("host").notNull(),
		/** A short device label from the extension's user agent, such as "Chrome on Windows". */
		label: pg.text("label").notNull(),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		lastUsedAt: pg.timestamp("last_used_at", { withTimezone: true }),
		expiresAt: pg.timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(t) => [
		pg.uniqueIndex("clipper_token_token_hash_idx").on(t.tokenHash),
		pg.index("clipper_token_user_id_idx").on(t.userId, t.organizationId),
		pg.index("clipper_token_expires_at_idx").on(t.expiresAt),
	],
);
