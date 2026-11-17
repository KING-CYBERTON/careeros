import type { ApplicationStatus } from "@reactive-resume/schema/applications/data";
import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";
import { user } from "./auth";
import { organization } from "./organization";

/**
 * CAREEROS (P5-T04, PRODUCT.md §6.2): an email template a member writes to an employer from. A tenant table: row level
 * security keys on `organization_id`, and the application adds the per-person rule on top of it. A row with no
 * `user_id` is a default of the organization, written only by its owners and admins and read by every member; a row
 * with a `user_id` is one member's own and is read only by them. The platform never sends these emails: the text is
 * filled in from an application and handed to the member's own mail app or copied.
 */
export const emailTemplate = pg.pgTable(
	"email_template",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		organizationId: pg
			.text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** Null is a default of the organization; otherwise the member who owns the template. */
		userId: pg.text("user_id").references(() => user.id, { onDelete: "cascade" }),
		kind: pg.text("kind").$type<"follow_up" | "thank_you" | "networking" | "negotiation" | "custom">().notNull(),
		/** The application stage it suggests itself for; null suits every stage. */
		stageCategory: pg.text("stage_category").$type<ApplicationStatus>(),
		name: pg.text("name").notNull(),
		subject: pg.text("subject").notNull(),
		/** Plain text, with {{variables}} filled in when it is used. */
		body: pg.text("body").notNull(),
		archivedAt: pg.timestamp("archived_at", { withTimezone: true }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(t) => [
		// The list of a member reads the organization's defaults and their own rows, led by the tenant column.
		pg.index("email_template_org_user_idx").on(t.organizationId, t.userId, t.archivedAt),
		pg.check(
			"email_template_kind_check",
			sql`${t.kind} in ('follow_up', 'thank_you', 'networking', 'negotiation', 'custom')`,
		),
		pg.check(
			"email_template_stage_check",
			sql`${t.stageCategory} is null or ${t.stageCategory} in ('saved', 'applied', 'screening', 'interview', 'offer', 'closed')`,
		),
		pg.check("email_template_name_check", sql`char_length(btrim(${t.name})) between 1 and 100`),
		pg.check("email_template_subject_check", sql`char_length(btrim(${t.subject})) between 1 and 300`),
		pg.check("email_template_body_check", sql`char_length(${t.body}) <= 10000`),
	],
);
