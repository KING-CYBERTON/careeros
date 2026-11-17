import type { BillingState, Transition } from "./state";
import type { BillingInterval } from "@reactive-resume/db/schema";
import { count, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { audit } from "./audit";
import { BillingError } from "./errors";

// CAREEROS (P3-T04): reading an organization's billing state and writing a state-machine answer. Everything here runs
// inside `withOrgContext` (row-level security applies) and, for writes, inside one transaction holding the
// organization's billing lock, so two events, or an event and the job, never interleave on one organization.

/** Serializes billing work per organization for the rest of the transaction. */
export async function lockOrganizationBilling(orgId: string): Promise<void> {
	await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`careeros_billing:${orgId}`}, 0))`);
}

/** The state `nextState` works from. Call inside the organization's scope. */
export async function loadBillingState(orgId: string): Promise<BillingState> {
	const [org] = await db
		.select({ status: schema.organization.status, planId: schema.organization.planId })
		.from(schema.organization)
		.where(eq(schema.organization.id, orgId))
		.limit(1);
	if (!org) throw new BillingError("org_not_found", `Organization ${orgId} does not exist.`);
	const [sub] = await db
		.select()
		.from(schema.subscription)
		.where(eq(schema.subscription.organizationId, orgId))
		.limit(1);
	if (!sub) throw new BillingError("subscription_not_found", `Organization ${orgId} has no subscription row.`);
	const [members] = await db.select({ n: count() }).from(schema.member).where(eq(schema.member.organizationId, orgId));
	return {
		orgStatus: org.status,
		planId: org.planId,
		memberCount: members?.n ?? 0,
		subscription: {
			provider: sub.provider,
			status: sub.status,
			seats: sub.seats,
			interval: (sub.billingInterval as BillingInterval | null) ?? null,
			providerCustomerId: sub.providerCustomerId,
			providerSubscriptionId: sub.providerSubscriptionId,
			periodStart: sub.currentPeriodStart,
			periodEnd: sub.currentPeriodEnd,
			trialEndsAt: sub.trialEndsAt,
			graceEndsAt: sub.graceEndsAt,
			pendingSeats: sub.pendingSeats,
			pendingReplacesSubscriptionId: sub.pendingReplacesSubscriptionId,
		},
	};
}

const COLUMN: Record<string, string> = {
	provider: "provider",
	status: "status",
	seats: "seats",
	interval: "billing_interval",
	providerCustomerId: "provider_customer_id",
	providerSubscriptionId: "provider_subscription_id",
	periodStart: "current_period_start",
	periodEnd: "current_period_end",
	trialEndsAt: "trial_ends_at",
	graceEndsAt: "grace_ends_at",
	pendingSeats: "pending_seats",
	pendingReplacesSubscriptionId: "pending_replaces_subscription_id",
};

/** The `careeros_set_subscription` field object for a patch: snake_case columns, dates as ISO strings. */
export function subscriptionFields(patch: Transition["subscription"]): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(patch)) {
		const column = COLUMN[key];
		if (column && value !== undefined) fields[column] = value instanceof Date ? value.toISOString() : value;
	}
	return fields;
}

export type ApplyContext = {
	/** Recorded in the audit rows: the provider id, `job`, or `trial`. */
	source: string;
	/** The user who acted; null for a verified provider event or the job. */
	actorUserId: string | null;
	reason: string;
};

/**
 * Writes a transition: the plan and status through `careeros_set_org_plan`, the subscription through
 * `careeros_set_subscription` (each writes its own audit row), then the machine's audit entries. Call inside a
 * transaction in the organization's scope. Does nothing for a transition that was not applied.
 */
export async function applyTransition(orgId: string, transition: Transition, ctx: ApplyContext): Promise<void> {
	if (!transition.applied) return;
	if (transition.planId !== null || transition.orgStatus !== null) {
		await db.execute(
			sql`select careeros_set_org_plan(${orgId}, ${transition.planId}, ${transition.orgStatus}, ${ctx.actorUserId}, ${ctx.reason})`,
		);
	}
	const fields = subscriptionFields(transition.subscription);
	if (Object.keys(fields).length > 0) {
		await db.execute(
			sql`select careeros_set_subscription(${orgId}, ${JSON.stringify(fields)}::jsonb, ${ctx.actorUserId}, ${ctx.source})`,
		);
	}
	for (const entry of transition.audit) {
		await audit({ actorUserId: ctx.actorUserId }, entry.action, { type: "subscription", id: orgId }, entry.metadata);
	}
}
