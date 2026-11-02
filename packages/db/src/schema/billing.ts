import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";
import { user } from "./auth";
import { organization } from "./organization";

// CAREEROS (P3-T01, phase plan D2, D3, D4, D7): plans, an organization's subscription, feature flags and the audit log.
// Reads go through `@careeros/billing`. Writes to an organization's plan, status and subscription happen only in the
// definer functions of the migration, never from the app role.

/** Plan ids the migration seeds. Stable keys; code may rely on them. */
export const PLAN_IDS = ["personal", "trial", "starter", "pro", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const ORGANIZATION_STATUSES = ["trial", "active", "past_due", "suspended"] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export const SUBSCRIPTION_PROVIDERS = ["none", "manual", "paystack", "stripe", "mpesa"] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "canceled", "none"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** Feature flag keys and audit actions share this shape. The migration's CHECK constraints use the same pattern. */
export const KEY_PATTERN = "^[a-z][a-z0-9_.]{1,63}$";

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

/** Global, not tenant-scoped. Prices are nullable: null means "contact us". */
export const plan = pg.pgTable(
	"plan",
	{
		id: pg.text("id").notNull().primaryKey(),
		name: pg.text("name").notNull(),
		/** `flat`: one price per organization. `per_seat`: the price is per seat. */
		pricingModel: pg.text("pricing_model").notNull().default("flat"),
		priceMonthlyUsdCents: pg.integer("price_monthly_usd_cents"),
		priceAnnualUsdCents: pg.integer("price_annual_usd_cents"),
		/** KES prices are whole shillings (integers), not minor units. */
		priceMonthlyKes: pg.integer("price_monthly_kes"),
		priceAnnualKes: pg.integer("price_annual_kes"),
		/** Null means unlimited. */
		seatLimit: pg.integer("seat_limit"),
		aiCreditsPerSeat: pg.integer("ai_credits_per_seat").notNull().default(0),
		/** A map of feature key to boolean. */
		features: pg
			.jsonb("features")
			.$type<Record<string, boolean>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		active: pg.boolean("active").notNull().default(true),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [pg.check("plan_pricing_model_check", sql`${t.pricingModel} in ('flat', 'per_seat')`)],
);

/** One row per organization. The app role reads it; only definer functions write it. */
export const subscription = pg.pgTable(
	"subscription",
	{
		organizationId: pg
			.text("organization_id")
			.notNull()
			.primaryKey()
			.references(() => organization.id, { onDelete: "cascade" }),
		planId: pg
			.text("plan_id")
			.notNull()
			.references(() => plan.id),
		provider: pg.text("provider").notNull().default("none"),
		providerCustomerId: pg.text("provider_customer_id"),
		providerSubscriptionId: pg.text("provider_subscription_id"),
		status: pg.text("status").notNull().default("none"),
		seats: pg.integer("seats").notNull().default(1),
		billingInterval: pg.text("billing_interval"),
		currentPeriodStart: pg.timestamp("current_period_start", { withTimezone: true }),
		currentPeriodEnd: pg.timestamp("current_period_end", { withTimezone: true }),
		trialEndsAt: pg.timestamp("trial_ends_at", { withTimezone: true }),
		graceEndsAt: pg.timestamp("grace_ends_at", { withTimezone: true }),
		aiOverageAllowed: pg.boolean("ai_overage_allowed").notNull().default(false),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		pg.check("subscription_provider_check", sql`${t.provider} in (${list(SUBSCRIPTION_PROVIDERS)})`),
		pg.check("subscription_status_check", sql`${t.status} in (${list(SUBSCRIPTION_STATUSES)})`),
		pg.check("subscription_seats_check", sql`${t.seats} > 0`),
		pg.check("subscription_billing_interval_check", sql`${t.billingInterval} in (${list(BILLING_INTERVALS)})`),
		pg.index("subscription_plan_idx").on(t.planId),
	],
);

/** A flag for one organization, or a global one (null organization). Tenant rows win over global rows (D4). */
export const featureFlag = pg.pgTable(
	"feature_flag",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		organizationId: pg.text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
		key: pg.text("key").notNull(),
		enabled: pg.boolean("enabled").notNull(),
		updatedBy: pg.text("updated_by").references(() => user.id, { onDelete: "set null" }),
		updatedAt: pg.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		pg.check("feature_flag_key_check", sql`${t.key} ~ ${sql.raw(`'${KEY_PATTERN}'`)}`),
		// A null organization is one value: there is at most one global flag per key.
		pg.uniqueIndex("feature_flag_org_key_key").on(sql`coalesce(${t.organizationId}, '')`, t.key),
	],
);

/**
 * Append-only. The id is a uuidv7 (time-sortable): the app generates it with `generateId()`, and the database default
 * `careeros_uuidv7()` serves the definer functions. A null organization is a platform-level action.
 */
export const auditLog = pg.pgTable(
	"audit_log",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.default(sql`public.careeros_uuidv7()::text`),
		organizationId: pg.text("organization_id").references(() => organization.id, { onDelete: "set null" }),
		actorUserId: pg.text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
		impersonatorUserId: pg.text("impersonator_user_id").references(() => user.id, { onDelete: "set null" }),
		action: pg.text("action").notNull(),
		targetType: pg.text("target_type"),
		targetId: pg.text("target_id"),
		metadata: pg
			.jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		ip: pg.text("ip"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		pg.check("audit_log_action_check", sql`${t.action} ~ ${sql.raw(`'${KEY_PATTERN}'`)}`),
		pg.index("audit_log_org_created_idx").on(t.organizationId, t.createdAt.desc()),
	],
);
