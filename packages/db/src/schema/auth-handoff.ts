import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

/**
 * CAREEROS (P2-T05, phase plan D5): one social or OIDC sign-in that starts on an organization host, runs on the
 * platform host and ends with a session on the organization host. A pre-authentication, platform-global table, like
 * Better Auth's `verification` table: it is read before any session or organization context exists, so it has no row
 * level security. It carries `organization_id` only to say which organization the sign-in is for.
 *
 * Nothing secret is stored in clear text. `browserBindingHash` is the SHA-256 of a verifier that only the starting
 * browser holds (cookie `careeros_handoff`), and `tokenHash` is the SHA-256 of the one-time token. Every expiry is
 * written with the database clock.
 */
export const authHandoff = pg.pgTable(
	"auth_handoff",
	{
		/** Random, at least 128 bits. Not secret on its own: redeeming also needs the token and the starting browser. */
		id: pg.text("id").notNull().primaryKey(),
		organizationId: pg
			.text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** The browser origin of the organization host that started the flow; always resolved from the host, never sent. */
		targetOrigin: pg.text("target_origin").notNull(),
		/** A validated relative path on the target origin. */
		returnTo: pg.text("return_to").notNull(),
		browserBindingHash: pg.text("browser_binding_hash").notNull(),
		provider: pg.text("provider").notNull(),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		/** The request itself: 10 minutes after it was created. */
		expiresAt: pg.timestamp("expires_at", { withTimezone: true }).notNull(),
		/** Set together by the issue step. */
		tokenHash: pg.text("token_hash"),
		tokenExpiresAt: pg.timestamp("token_expires_at", { withTimezone: true }),
		userId: pg.text("user_id").references(() => user.id, { onDelete: "cascade" }),
		redeemedAt: pg.timestamp("redeemed_at", { withTimezone: true }),
	},
	(t) => [
		pg.index("auth_handoff_expires_at_idx").on(t.expiresAt),
		pg.check(
			"auth_handoff_token_state_check",
			sql`(${t.tokenHash} is null) = (${t.tokenExpiresAt} is null) and (${t.tokenHash} is null) = (${t.userId} is null)`,
		),
	],
);
