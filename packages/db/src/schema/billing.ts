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

// CAREEROS (P3-T04): `fake` is the test provider (never accepted in production, see packages/env).
export const SUBSCRIPTION_PROVIDERS = ["none", "manual", "paystack", "stripe", "mpesa", "fake"] as const;
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
		// CAREEROS (P3-T05): a seat change that takes effect at the next paid period. `pendingSeats` is the new count;
		// `pendingReplacesSubscriptionId` is the provider subscription being replaced, so its own cancellation event is not
		// mistaken for the customer cancelling. Both are cleared when the payment for the new count arrives.
		pendingSeats: pg.integer("pending_seats"),
		pendingReplacesSubscriptionId: pg.text("pending_replaces_subscription_id"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		pg.check("subscription_provider_check", sql`${t.provider} in (${list(SUBSCRIPTION_PROVIDERS)})`),
		pg.check("subscription_status_check", sql`${t.status} in (${list(SUBSCRIPTION_STATUSES)})`),
		pg.check("subscription_seats_check", sql`${t.seats} > 0`),
		pg.check("subscription_pending_seats_check", sql`${t.pendingSeats} is null or ${t.pendingSeats} > 0`),
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

// CAREEROS (P3-T04, phase plan D9): what the provider events did. `duplicate` is never stored (a duplicate adds no row);
// it is the answer of the intake and is listed so the CHECK and the code share one vocabulary.
export const BILLING_EVENT_OUTCOMES = ["applied", "duplicate", "ignored", "error"] as const;
export type BillingEventOutcome = (typeof BILLING_EVENT_OUTCOMES)[number];

/**
 * Global, not tenant-scoped: provider ids and normalized fields only, never card data. The app role has no privilege on
 * it at all; the definer function `careeros_record_billing_event` is the only way in (the unique key on
 * (provider, provider_event_id) makes a repeated event a no-op). `organization_id` names the organization the verified
 * metadata pointed at; it is not a foreign key, so an event for a deleted organization can still be recorded.
 */
export const billingEvent = pg.pgTable(
	"billing_event",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.default(sql`gen_random_uuid()::text`),
		provider: pg.text("provider").notNull(),
		providerEventId: pg.text("provider_event_id").notNull(),
		organizationId: pg.text("organization_id"),
		type: pg.text("type").notNull(),
		receivedAt: pg.timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
		processedAt: pg.timestamp("processed_at", { withTimezone: true }),
		outcome: pg.text("outcome").notNull(),
		error: pg.text("error"),
	},
	(t) => [
		pg.uniqueIndex("billing_event_provider_event_key").on(t.provider, t.providerEventId),
		pg.index("billing_event_org_received_idx").on(t.organizationId, t.receivedAt.desc()),
		pg.check("billing_event_outcome_check", sql`${t.outcome} in (${list(BILLING_EVENT_OUTCOMES)})`),
	],
);

/**
 * CAREEROS (P3-T05): the provider's plan for one (CareerOS plan, interval, currency, seats, amount), created lazily and
 * cached here. Paystack plans have a fixed amount and no quantity, so each seat count has its own plan code, and the
 * amount is part of the key: a price change in the `plan` table makes a new provider plan rather than an old price.
 * Global and platform only: the app role has no privilege on the table and reads and writes it through definer functions.
 */
export const billingProviderPlan = pg.pgTable(
	"billing_provider_plan",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.default(sql`gen_random_uuid()::text`),
		provider: pg.text("provider").notNull(),
		planId: pg
			.text("plan_id")
			.notNull()
			.references(() => plan.id),
		billingInterval: pg.text("billing_interval").notNull(),
		currency: pg.text("currency").notNull(),
		seats: pg.integer("seats").notNull(),
		/** In the provider's smallest unit (cents). */
		amount: pg.bigint("amount", { mode: "number" }).notNull(),
		providerPlanCode: pg.text("provider_plan_code").notNull(),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		pg
			.uniqueIndex("billing_provider_plan_key")
			.on(t.provider, t.planId, t.billingInterval, t.currency, t.seats, t.amount),
		pg.uniqueIndex("billing_provider_plan_code_key").on(t.provider, t.providerPlanCode),
		pg.check("billing_provider_plan_interval_check", sql`${t.billingInterval} in (${list(BILLING_INTERVALS)})`),
		pg.check("billing_provider_plan_seats_check", sql`${t.seats} > 0 and ${t.amount} >= 0`),
	],
);
