import { defineRelations, sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";
import { account, session, user } from "./auth";
import { ORGANIZATION_STATUSES, plan } from "./billing";

// Tables for the Better Auth `organization` plugin (CareerOS tenancy, P1-T01). They define tenancy rather than hold
// tenant-scoped data; Better Auth's membership checks control access.

export const organization = pg.pgTable(
	"organization",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		name: pg.text("name").notNull(),
		slug: pg.text("slug").notNull().unique(),
		logo: pg.text("logo"),
		metadata: pg.text("metadata"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		// CAREEROS (P3-T01, phase plan D3): the plan and status of the organization. Better Auth's organization plugin does not
		// know these columns and ignores them. The app role cannot change them (a trigger in the P3-T01 migration refuses it);
		// only the definer function `careeros_set_org_plan` writes them.
		status: pg.text("status").notNull().default("active"),
		planId: pg
			.text("plan_id")
			.notNull()
			.default("personal")
			.references(() => plan.id),
		statusChangedAt: pg.timestamp("status_changed_at", { withTimezone: true }),
	},
	(t) => [
		pg.check(
			"organization_status_check",
			sql`${t.status} in (${sql.raw(ORGANIZATION_STATUSES.map((status) => `'${status}'`).join(", "))})`,
		),
	],
);

// CAREEROS (P3-T08, phase plan D8): a group of members inside one organization (a class, an intake). A tenant table:
// row-level security keys on `organization_id`, and a member or invitation points at its cohort through a composite
// foreign key, so a cohort can never belong to another organization than the row that names it.
export const cohort = pg.pgTable(
	"cohort",
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
		name: pg.text("name").notNull(),
		description: pg.text("description"),
		startsOn: pg.date("starts_on", { mode: "string" }),
		endsOn: pg.date("ends_on", { mode: "string" }),
		archivedAt: pg.timestamp("archived_at", { withTimezone: true }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(t) => [
		// The target of the composite foreign keys from member and invitation.
		pg.unique("cohort_organization_id_id_unique").on(t.organizationId, t.id),
		// One name per organization, whatever its case; archived cohorts keep their name.
		pg.uniqueIndex("cohort_organization_name_key").on(t.organizationId, sql`lower(${t.name})`),
		pg.check("cohort_name_check", sql`char_length(btrim(${t.name})) between 1 and 100`),
		pg.check("cohort_description_check", sql`${t.description} is null or char_length(${t.description}) <= 1000`),
		pg.check("cohort_dates_check", sql`${t.startsOn} is null or ${t.endsOn} is null or ${t.endsOn} >= ${t.startsOn}`),
	],
);

export const member = pg.pgTable(
	"member",
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
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: pg.text("role").notNull().default("member"),
		/** Cohort the member belongs to; cleared (not deleted) when the cohort is deleted. */
		cohortId: pg.text("cohort_id"),
		invitedBy: pg.text("invited_by").references(() => user.id, { onDelete: "set null" }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		pg.uniqueIndex().on(t.organizationId, t.userId),
		pg.index().on(t.userId),
		// CAREEROS (P3-T08): the cohort must be one of the member's own organization. The migration makes the key
		// ON DELETE SET NULL (cohort_id), which clears only the cohort column (PostgreSQL 15+), never the tenant column.
		pg
			.foreignKey({
				name: "member_org_cohort_fkey",
				columns: [t.organizationId, t.cohortId],
				foreignColumns: [cohort.organizationId, cohort.id],
			})
			.onDelete("set null"),
		pg.index("member_org_cohort_idx").on(t.organizationId, t.cohortId),
	],
);

export const invitation = pg.pgTable(
	"invitation",
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
		email: pg.text("email").notNull(),
		role: pg.text("role"),
		status: pg.text("status").notNull().default("pending"),
		expiresAt: pg.timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		inviterId: pg
			.text("inviter_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// CAREEROS (P3-T08): the cohort the member joins on accepting (a bulk invitation names one). Cleared with the cohort.
		cohortId: pg.text("cohort_id"),
	},
	(t) => [
		pg.index().on(t.organizationId, t.email),
		pg
			.foreignKey({
				name: "invitation_org_cohort_fkey",
				columns: [t.organizationId, t.cohortId],
				foreignColumns: [cohort.organizationId, cohort.id],
			})
			.onDelete("set null"),
	],
);

// Better Auth (joins enabled) joins members to users and organizations, and organizations to members and invitations.
// This is the full relation set for the database client: upstream's auth relations plus the organization tables.
export const authOrganizationRelations = defineRelations(
	{ user, session, account, organization, member, invitation },
	(r) => ({
		user: {
			accounts: r.many.account({ from: r.user.id, to: r.account.userId }),
			sessions: r.many.session({ from: r.user.id, to: r.session.userId }),
			members: r.many.member({ from: r.user.id, to: r.member.userId }),
		},
		session: {
			user: r.one.user({ from: r.session.userId, to: r.user.id }),
		},
		account: {
			user: r.one.user({ from: r.account.userId, to: r.user.id }),
		},
		organization: {
			members: r.many.member({ from: r.organization.id, to: r.member.organizationId }),
			invitations: r.many.invitation({ from: r.organization.id, to: r.invitation.organizationId }),
		},
		member: {
			user: r.one.user({ from: r.member.userId, to: r.user.id }),
			organization: r.one.organization({ from: r.member.organizationId, to: r.organization.id }),
		},
		invitation: {
			organization: r.one.organization({ from: r.invitation.organizationId, to: r.organization.id }),
		},
	}),
);
