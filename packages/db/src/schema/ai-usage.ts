import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

// CAREEROS (P3-T03, phase plan D5): one row per metered AI call. Append-only for the app role (SELECT and INSERT only,
// see the migration). `@careeros/ai-metering` owns the rules for what a row means (price table, credits).

export const AI_USAGE_SOURCES = ["platform", "own_key"] as const;
export type AiUsageSource = (typeof AI_USAGE_SOURCES)[number];

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

/** Like `audit_log`, the id is a uuidv7 text: the database default `careeros_uuidv7()` fills it. */
export const aiUsage = pg.pgTable(
	"ai_usage",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.default(sql`public.careeros_uuidv7()::text`),
		organizationId: pg
			.text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: pg.text("user_id").references(() => user.id, { onDelete: "set null" }),
		source: pg.text("source").notNull(),
		/** A key from `AI_FEATURES` in `@careeros/ai-metering`, for example `resume.improve`. */
		feature: pg.text("feature").notNull(),
		provider: pg.text("provider").notNull(),
		model: pg.text("model").notNull(),
		inputTokens: pg.integer("input_tokens").notNull().default(0),
		outputTokens: pg.integer("output_tokens").notNull().default(0),
		cachedInputTokens: pg.integer("cached_input_tokens").notNull().default(0),
		/** Millionths of a US dollar. Zero for `own_key` rows. */
		costUsdMicros: pg.bigint("cost_usd_micros", { mode: "number" }).notNull().default(0),
		/** 1 credit = USD 0.01 of platform cost, rounded up per call. Zero for `own_key` rows. */
		credits: pg.integer("credits").notNull().default(0),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		pg.check("ai_usage_source_check", sql`${t.source} in (${list(AI_USAGE_SOURCES)})`),
		pg.index("ai_usage_org_created_idx").on(t.organizationId, t.createdAt),
	],
);
