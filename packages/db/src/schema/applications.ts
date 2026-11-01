import type {
	AiMetadata,
	ApplicationClosedReason,
	ApplicationStatus,
	ApplicationTimelineEntry,
	Contact,
	PostingSource,
} from "@reactive-resume/schema/applications/data";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";
import { user } from "./auth";
import { coverLetter, coverLetterVersion } from "./cover-letter";
import { organization } from "./organization";
import { resume, resumeVersion } from "./resume";

// CAREEROS (P1-T06, D11): the pipeline is per (organization, user), not per user. Row-level security keys on
// `organization_id`; writers set it from `requireOrgId()` and upserts conflict on the composite key.
export const applicationPipeline = pg.pgTable(
	"application_pipeline",
	{
		organizationId: pg
			.text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		revision: pg.integer("revision").notNull().default(0),
	},
	(t) => [pg.primaryKey({ columns: [t.organizationId, t.userId] })],
);

export const applicationLane = pg.pgTable(
	"application_lane",
	{
		id: pg
			.text("id")
			.notNull()
			.$defaultFn(() => generateId()),
		// CAREEROS (P1-T06): tenant column. The default lanes keep their deterministic ids in every organization, so the
		// primary key is (organization_id, id) rather than id alone.
		organizationId: pg
			.text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		category: pg.text("category").$type<ApplicationStatus>().notNull(),
		label: pg.text("label"),
		color: pg.text("color").notNull(),
		position: pg.integer("position").notNull(),
		systemKey: pg.text("system_key").$type<ApplicationStatus>(),
		closedReason: pg.text("closed_reason").$type<ApplicationClosedReason>(),
		retiredAt: pg.timestamp("retired_at", { withTimezone: true }),
	},
	(t) => [
		// CAREEROS (P1-T06): keys and indexes are scoped to (organization, user) and led by the organization.
		pg.primaryKey({ columns: [t.organizationId, t.id] }),
		pg.unique("application_lane_owner_id_unique").on(t.organizationId, t.userId, t.id),
		pg.unique("application_lane_owner_system_unique").on(t.organizationId, t.userId, t.systemKey),
		pg.index().on(t.organizationId, t.userId),
	],
);

// A tracked job application. Points at the live Reactive Resume that was sent (resumeId),
// which is the reason this lives inside the product rather than a generic tracker.
export const application = pg.pgTable(
	"application",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		// CAREEROS (P1-T06): tenant column. Row-level security keys on it; inserts set it from `requireOrgId()`.
		organizationId: pg
			.text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		company: pg.text("company").notNull(),
		role: pg.text("role").notNull(),
		location: pg.text("location"),
		salary: pg.text("salary"),
		// Fixed pipeline stage enum (see applicationStatusSchema); stored as text per repo convention.
		status: pg.text("status").$type<ApplicationStatus>().notNull().default("saved"),
		laneId: pg.text("lane_id"),
		// Why a closed application ended (not selected, withdrew, accepted another offer, no response). Insights use it.
		closedReason: pg.text("closed_reason").$type<ApplicationClosedReason>(),
		// Live link to one of the user's resumes. Kept on resume delete (set null) so the
		// application history survives.
		resumeId: pg.text("resume_id").references(() => resume.id, { onDelete: "set null" }),
		// The saved cover letter sent with this application.
		// Typed explicitly: cover_letter references application too, and the cycle would defeat inference.
		coverLetterId: pg.text("cover_letter_id").references((): AnyPgColumn => coverLetter.id, { onDelete: "set null" }),
		// The linked resume as it was when the application reached Applied, and its Check score then.
		sentResumeVersionId: pg.text("sent_resume_version_id").references(() => resumeVersion.id, { onDelete: "set null" }),
		sentCheckScore: pg.smallint("sent_check_score"),
		// The linked letter as it was when the application was sent.
		sentCoverLetterVersionId: pg
			.text("sent_cover_letter_version_id")
			.references((): AnyPgColumn => coverLetterVersion.id, { onDelete: "set null" }),
		source: pg.text("source"),
		tags: pg.text("tags").array().notNull().default([]),
		// --- AI reservations (no working AI this pass; see feature AI roadmap) ---
		sourceUrl: pg.text("source_url"),
		jobDescription: pg.text("job_description"),
		postingSource: pg.jsonb("posting_source").$type<PostingSource>(),
		// What the posting asks for, as read from it when the application was added.
		requirements: pg.jsonb("requirements").notNull().$type<string[]>().default([]),
		matchScore: pg.integer("match_score"),
		aiMetadata: pg.jsonb("ai_metadata").$type<AiMetadata>(),
		notes: pg.text("notes"),
		// An uploaded resume file (PDF) sent with this application, distinct from the live
		// resumeId link. Stored as the storage URL + original filename for display.
		resumeFileUrl: pg.text("resume_file_url"),
		resumeFileName: pg.text("resume_file_name"),
		// A cover letter sent with this application (PDF/doc uploaded to storage). Stored as the
		// key returned by the storage upload plus the original filename for display.
		coverLetterUrl: pg.text("cover_letter_url"),
		coverLetterName: pg.text("cover_letter_name"),
		followUpAt: pg.timestamp("follow_up_at", { withTimezone: true }),
		followUpNote: pg.text("follow_up_note"),
		contacts: pg.jsonb("contacts").notNull().$type<Contact[]>().default([]),
		activity: pg.jsonb("activity").notNull().$type<ApplicationTimelineEntry[]>().default([]),
		appliedAt: pg.timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.index().on(t.userId),
		pg.index().on(t.userId, t.updatedAt.desc()),
		pg.foreignKey({
			name: "application_lane_owner_fk",
			// CAREEROS (P1-T06): a lane is looked up inside the application's own organization.
			columns: [t.organizationId, t.userId, t.laneId],
			foreignColumns: [applicationLane.organizationId, applicationLane.userId, applicationLane.id],
		}),
		pg.index().on(t.userId, t.laneId),
		// CAREEROS: organization-led twins of the list indexes above (P1-T06).
		pg.index().on(t.organizationId, t.userId, t.updatedAt.desc()),
		pg.index().on(t.organizationId, t.userId, t.laneId),
		// CAREEROS (P1-T07): the target of career_workspace's composite foreign key.
		pg.unique("application_organization_id_id_unique").on(t.organizationId, t.id),
	],
);
