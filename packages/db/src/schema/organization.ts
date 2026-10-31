import { defineRelations } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";
import { account, session, user } from "./auth";

// Tables for the Better Auth `organization` plugin (CareerOS tenancy, P1-T01). They define tenancy rather than hold
// tenant-scoped data; Better Auth's membership checks control access.

export const organization = pg.pgTable("organization", {
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
});

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
		/** Cohort the member belongs to. No foreign key until the cohort table exists (Phase 3). */
		cohortId: pg.text("cohort_id"),
		invitedBy: pg.text("invited_by").references(() => user.id, { onDelete: "set null" }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [pg.uniqueIndex().on(t.organizationId, t.userId), pg.index().on(t.userId)],
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
	},
	(t) => [pg.index().on(t.organizationId, t.email)],
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
