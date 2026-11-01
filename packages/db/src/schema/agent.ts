import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";
import { application } from "./applications";
import { user } from "./auth";
import { coverLetter } from "./cover-letter";
import { organization } from "./organization";
import { resume } from "./resume";

// CAREEROS (P1-T08, D4/D11): the assistant and AI tables carry the tenant column. Row-level security keys on
// `organization_id`; writers set it from `requireOrgId()`, and every index that led with `user_id` leads with the
// organization. A reference to another tenant row is a composite foreign key `(organization_id, x_id)` onto the parent's
// `(organization_id, id)` key, so the database refuses a cross-organization link for every writer. Those keys are
// DEFERRABLE INITIALLY DEFERRED because the guest move changes the organization of one table at a time inside a single
// transaction (see careeros_move_guest_agent). The migration writes `ON DELETE SET NULL (x_id)` (PostgreSQL 15+), so the
// tenant column is never nulled; drizzle cannot express the column list or the deferral, and the snapshot only records
// the action.
const tenant = () =>
	pg
		.text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" });

type AgentUiMessage = Record<string, unknown>;
type StoredJsonPatchOperation =
	| { op: "add"; path: string; value: unknown }
	| { op: "remove"; path: string }
	| { op: "replace"; path: string; value: unknown }
	| { op: "move"; path: string; from: string }
	| { op: "copy"; path: string; from: string }
	| { op: "test"; path: string; value: unknown };

export const aiProvider = pg.pgTable(
	"ai_providers",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: tenant(),
		label: pg.text("label").notNull(),
		provider: pg.text("provider").notNull(),
		model: pg.text("model").notNull(),
		baseUrl: pg.text("base_url"),
		encryptedApiKey: pg.text("encrypted_api_key").notNull(),
		apiKeySalt: pg.text("api_key_salt").notNull(),
		apiKeyHash: pg.text("api_key_hash").notNull(),
		apiKeyPreview: pg.text("api_key_preview").notNull(),
		testStatus: pg.text("test_status").notNull().default("untested"),
		testError: pg.text("test_error"),
		lastTestedAt: pg.timestamp("last_tested_at", { withTimezone: true }),
		lastUsedAt: pg.timestamp("last_used_at", { withTimezone: true }),
		enabled: pg.boolean("enabled").notNull().default(false),
		/** The connection every automatic choice uses while it's on and tested; one per user. */
		isDefault: pg.boolean("is_default").notNull().default(false),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		// CAREEROS (P1-T08, D11): saved connections are per (organization, user), and so is the one default.
		pg.index().on(t.organizationId, t.userId, t.enabled),
		pg.index().on(t.organizationId, t.userId, t.lastUsedAt.desc()),
		pg.index().on(t.organizationId, t.userId, t.createdAt.asc()),
		pg
			.uniqueIndex()
			.on(t.organizationId, t.userId)
			.where(sql`${t.isDefault}`),
		pg.unique("ai_providers_organization_id_id_unique").on(t.organizationId, t.id),
	],
);

export const agentThread = pg.pgTable(
	"agent_threads",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: tenant(),
		// CAREEROS (P1-T08): the five links below are composite foreign keys in the table's extra config.
		aiProviderId: pg.text("ai_provider_id"),
		sourceResumeId: pg.text("source_resume_id"),
		workingResumeId: pg.text("working_resume_id"),
		// A conversation is about one document: the resume above, or this letter.
		coverLetterId: pg.text("cover_letter_id"),
		scope: pg.text("scope").notNull().default("document"),
		applicationId: pg.text("application_id"),
		title: pg.text("title").notNull(),
		// Outcomes for past conversations: "3 of 4 edits accepted".
		editsProposed: pg.integer("edits_proposed").notNull().default(0),
		editsAccepted: pg.integer("edits_accepted").notNull().default(0),
		status: pg.text("status").notNull().default("active"),
		// Per-thread "Review edits" toggle: when true, apply_resume_patch requires user approval.
		reviewPatches: pg.boolean("review_patches").notNull().default(false),
		activeRunId: pg.text("active_run_id"),
		activeStreamId: pg.text("active_stream_id"),
		activeRunStartedAt: pg.timestamp("active_run_started_at", { withTimezone: true }),
		lastMessageAt: pg.timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
		archivedAt: pg.timestamp("archived_at", { withTimezone: true }),
		deletedAt: pg.timestamp("deleted_at", { withTimezone: true }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.index().on(t.organizationId, t.userId, t.status, t.lastMessageAt.desc()),
		pg.index().on(t.workingResumeId),
		pg.index().on(t.coverLetterId),
		pg.index().on(t.aiProviderId),
		pg.unique("agent_threads_organization_id_id_unique").on(t.organizationId, t.id),
		pg
			.foreignKey({
				name: "agent_threads_org_ai_provider_fkey",
				columns: [t.organizationId, t.aiProviderId],
				foreignColumns: [aiProvider.organizationId, aiProvider.id],
			})
			.onDelete("set null"),
		pg
			.foreignKey({
				name: "agent_threads_org_source_resume_fkey",
				columns: [t.organizationId, t.sourceResumeId],
				foreignColumns: [resume.organizationId, resume.id],
			})
			.onDelete("set null"),
		pg
			.foreignKey({
				name: "agent_threads_org_working_resume_fkey",
				columns: [t.organizationId, t.workingResumeId],
				foreignColumns: [resume.organizationId, resume.id],
			})
			.onDelete("set null"),
		pg
			.foreignKey({
				name: "agent_threads_org_cover_letter_fkey",
				columns: [t.organizationId, t.coverLetterId],
				foreignColumns: [coverLetter.organizationId, coverLetter.id],
			})
			.onDelete("set null"),
		pg
			.foreignKey({
				name: "agent_threads_org_application_fkey",
				columns: [t.organizationId, t.applicationId],
				foreignColumns: [application.organizationId, application.id],
			})
			.onDelete("cascade"),
	],
);

export const agentMessage = pg.pgTable(
	"agent_messages",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: tenant(),
		threadId: pg.text("thread_id").notNull(),
		role: pg.text("role").notNull(),
		status: pg.text("status").notNull().default("completed"),
		sequence: pg.integer("sequence").notNull(),
		uiMessage: pg.jsonb("ui_message").notNull().$type<AgentUiMessage>(),
		error: pg.text("error"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.uniqueIndex().on(t.threadId, t.sequence),
		pg.index().on(t.organizationId, t.userId, t.createdAt.desc()),
		pg.unique("agent_messages_organization_id_id_unique").on(t.organizationId, t.id),
		pg
			.foreignKey({
				name: "agent_messages_org_thread_fkey",
				columns: [t.organizationId, t.threadId],
				foreignColumns: [agentThread.organizationId, agentThread.id],
			})
			.onDelete("cascade"),
	],
);

export const agentAttachment = pg.pgTable(
	"agent_attachments",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: tenant(),
		threadId: pg.text("thread_id").notNull(),
		messageId: pg.text("message_id"),
		storageKey: pg.text("storage_key").notNull(),
		filename: pg.text("filename").notNull(),
		mediaType: pg.text("media_type").notNull(),
		size: pg.integer("size").notNull(),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		pg.index().on(t.threadId),
		pg.index().on(t.messageId),
		pg.index().on(t.organizationId, t.userId),
		pg
			.foreignKey({
				name: "agent_attachments_org_thread_fkey",
				columns: [t.organizationId, t.threadId],
				foreignColumns: [agentThread.organizationId, agentThread.id],
			})
			.onDelete("cascade"),
		pg
			.foreignKey({
				name: "agent_attachments_org_message_fkey",
				columns: [t.organizationId, t.messageId],
				foreignColumns: [agentMessage.organizationId, agentMessage.id],
			})
			.onDelete("set null"),
	],
);

export const agentAction = pg.pgTable(
	"agent_actions",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: tenant(),
		threadId: pg.text("thread_id").notNull(),
		messageId: pg.text("message_id"),
		resumeId: pg.text("resume_id"),
		kind: pg.text("kind").notNull(),
		status: pg.text("status").notNull().default("applied"),
		title: pg.text("title").notNull(),
		summary: pg.text("summary"),
		operations: pg.jsonb("operations").notNull().$type<StoredJsonPatchOperation[]>(),
		snapshotData: pg.jsonb("snapshot_data").$type<ResumeData | null>(),
		baseUpdatedAt: pg.timestamp("base_updated_at", { withTimezone: true }).notNull(),
		appliedUpdatedAt: pg.timestamp("applied_updated_at", { withTimezone: true }).notNull(),
		revertedAt: pg.timestamp("reverted_at", { withTimezone: true }),
		revertMessage: pg.text("revert_message"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.index().on(t.threadId, t.createdAt.desc()),
		pg.index().on(t.resumeId),
		pg.index().on(t.messageId),
		pg.index().on(t.organizationId, t.userId),
		pg
			.foreignKey({
				name: "agent_actions_org_thread_fkey",
				columns: [t.organizationId, t.threadId],
				foreignColumns: [agentThread.organizationId, agentThread.id],
			})
			.onDelete("cascade"),
		pg
			.foreignKey({
				name: "agent_actions_org_message_fkey",
				columns: [t.organizationId, t.messageId],
				foreignColumns: [agentMessage.organizationId, agentMessage.id],
			})
			.onDelete("set null"),
		pg
			.foreignKey({
				name: "agent_actions_org_resume_fkey",
				columns: [t.organizationId, t.resumeId],
				foreignColumns: [resume.organizationId, resume.id],
			})
			.onDelete("set null"),
	],
);
