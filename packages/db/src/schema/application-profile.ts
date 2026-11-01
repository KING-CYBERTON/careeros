import type { ApplicationProfileData } from "@reactive-resume/schema/application-profile";
import * as pg from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

/**
 * Kept outside Career knowledge, resume data and submitted snapshots.
 * CAREEROS (P1-T06, D11): one profile per (organization, user); row-level security keys on `organization_id`.
 */
export const applicationProfile = pg.pgTable(
	"application_profile",
	{
		organizationId: pg
			.text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		data: pg.jsonb("data").notNull().$type<ApplicationProfileData>(),
		reviewedAt: pg.timestamp("reviewed_at", { withTimezone: true }).notNull(),
		revision: pg.text("revision").notNull(),
	},
	(t) => [pg.primaryKey({ columns: [t.organizationId, t.userId] })],
);
