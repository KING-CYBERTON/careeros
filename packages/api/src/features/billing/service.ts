import type { CheckoutMethod } from "@careeros/billing";
import type { BillingInterval } from "@reactive-resume/db/schema";
import {
	getEntitlements,
	isSelfServicePlan,
	listActivePlans,
	loadBillingState,
	loadPlanPrices,
	priceFor,
	startTrial as startOrganizationTrial,
	TRIAL_PLAN_ID,
} from "@careeros/billing";
import { PaystackError, ProviderUnsupportedError, recordPendingSeatChange } from "@careeros/billing";
import { requireOrgId } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";
import { getBillingProvider, isBillingEnabled } from "./provider";

// CAREEROS (P3-T04): what an organization owner can do about billing. The organization is always the caller's own (the
// request's scope); the client never names one. The subscription changes only when the provider's verified webhook says
// so (apps/server/src/http/billing-webhook.ts), except for a trial, which the state machine starts here.

type Role = "owner" | "admin" | "member" | null;

async function roleOf(userId: string): Promise<{ organizationId: string; role: Role }> {
	const organizationId = requireOrgId();
	const [membership] = await db
		.select({ role: schema.member.role })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
		.limit(1);
	// Better Auth stores several roles as a comma separated list.
	const roles = membership?.role.split(",").map((role) => role.trim()) ?? [];
	return {
		organizationId,
		role: roles.includes("owner") ? "owner" : roles.includes("admin") ? "admin" : roles.length ? "member" : null,
	};
}

async function requireOwner(userId: string): Promise<string> {
	const { organizationId, role } = await roleOf(userId);
	if (role !== "owner")
		throw new ORPCError("FORBIDDEN", { message: "Only the owner of the organization can do this." });
	return organizationId;
}

function requireProvider() {
	const provider = getBillingProvider();
	if (!provider) throw new ORPCError("PRECONDITION_FAILED", { message: "Billing is not enabled on this server." });
	return provider;
}

/** What an owner may be told when the payment provider fails: never the provider's own text. */
function providerFailure(error: unknown, unsupported: string): unknown {
	if (error instanceof ProviderUnsupportedError) return new ORPCError("PRECONDITION_FAILED", { message: unsupported });
	if (error instanceof PaystackError) {
		console.error(`[billing] provider call failed status=${error.status ?? "none"}`);
		return new ORPCError("BAD_GATEWAY", {
			message: error.retryable
				? "The payment provider is not answering. Try again in a moment."
				: "The payment provider refused the request. Check the details and try again.",
		});
	}
	return error;
}

// CAREEROS (P3-T06): the provider sends the customer back to the billing return page, which waits for the confirmation.
const returnUrl = () => new URL("/dashboard/organization/billing/return", env.APP_URL).toString();

/** Seats must cover the people already in the organization; a downgrade below the member count is refused here. */
function checkSeats(seats: number, memberCount: number, seatLimit: number | null) {
	if (seats < memberCount)
		throw new ORPCError("BAD_REQUEST", {
			message: `The organization has ${memberCount} members, so it needs at least ${memberCount} seats. Remove members first.`,
		});
	if (seatLimit !== null && seats > seatLimit)
		throw new ORPCError("BAD_REQUEST", { message: `This plan allows at most ${seatLimit} seats.` });
}

export async function getBilling(userId: string) {
	const { organizationId, role } = await roleOf(userId);
	if (role !== "owner" && role !== "admin")
		throw new ORPCError("FORBIDDEN", { message: "Only an owner or admin of the organization can see billing." });
	const state = await loadBillingState(organizationId);
	const entitlements = await getEntitlements(organizationId);
	const plans = await listActivePlans();
	return {
		planId: state.planId,
		status: entitlements.status as "trial" | "active" | "past_due" | "suspended",
		subscription: {
			status: state.subscription.status as "trialing" | "active" | "past_due" | "canceled" | "none",
			provider: state.subscription.provider,
			seats: state.subscription.seats,
			interval: state.subscription.interval,
			currentPeriodStart: state.subscription.periodStart,
			currentPeriodEnd: state.subscription.periodEnd,
			trialEndsAt: state.subscription.trialEndsAt,
			graceEndsAt: state.subscription.graceEndsAt,
		},
		memberCount: state.memberCount,
		billingEnabled: isBillingEnabled(),
		canManage: role === "owner",
		canStartTrial:
			role === "owner" &&
			isBillingEnabled() &&
			state.planId === "personal" &&
			state.orgStatus === "active" &&
			state.subscription.trialEndsAt === null &&
			state.subscription.status === "none",
		plans: plans
			.map((plan) => ({
				id: plan.id,
				name: plan.name,
				pricingModel: plan.pricingModel as "flat" | "per_seat",
				seatLimit: plan.seatLimit,
				priceMonthlyUsdCents: plan.priceMonthlyUsdCents,
				priceAnnualUsdCents: plan.priceAnnualUsdCents,
				priceMonthlyKes: plan.priceMonthlyKes,
				priceAnnualKes: plan.priceAnnualKes,
				aiCreditsPerSeat: plan.aiCreditsPerSeat,
				features: plan.features,
				selfService: isSelfServicePlan(plan.id),
			}))
			.sort(
				(a, b) =>
					(a.priceMonthlyUsdCents ?? Number.MAX_SAFE_INTEGER) - (b.priceMonthlyUsdCents ?? Number.MAX_SAFE_INTEGER),
			),
	};
}

// CAREEROS (P3-T06): the payments of the organization, from the audit rows the state machine and the manual payment
// function write for a verified payment. RLS scopes the read; the organization filter is stated as well.
const PAYMENT_ACTIONS = ["billing.checkout_completed", "billing.payment_succeeded", "billing.manual_payment"];

const text = (value: unknown, max = 128): string | null =>
	typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
const whole = (value: unknown): number | null =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const moment = (value: unknown): Date | null => {
	if (typeof value !== "string") return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
};

export async function listInvoices(userId: string) {
	const { organizationId, role } = await roleOf(userId);
	if (role !== "owner" && role !== "admin")
		throw new ORPCError("FORBIDDEN", { message: "Only an owner or admin of the organization can see billing." });
	const rows = await db
		.select({ id: schema.auditLog.id, metadata: schema.auditLog.metadata, createdAt: schema.auditLog.createdAt })
		.from(schema.auditLog)
		.where(and(eq(schema.auditLog.organizationId, organizationId), inArray(schema.auditLog.action, PAYMENT_ACTIONS)))
		.orderBy(desc(schema.auditLog.createdAt))
		.limit(100);
	const seen = new Set<string>();
	const invoices = [];
	for (const row of rows) {
		const meta = row.metadata;
		const amount = whole(meta.amount);
		const currency = text(meta.currency, 3);
		const periodEnd = moment(meta.periodEnd);
		// A checkout and the payment it made can both be audited: list the payment once.
		const key = amount !== null && periodEnd ? `${currency}:${amount}:${periodEnd.toISOString()}` : null;
		if (key) {
			if (seen.has(key)) continue;
			seen.add(key);
		}
		const interval: BillingInterval | null =
			meta.interval === "month" || meta.interval === "year" ? meta.interval : null;
		const method: "card" | "mpesa" | null = meta.method === "card" || meta.method === "mpesa" ? meta.method : null;
		invoices.push({
			id: row.id,
			date: row.createdAt,
			amount,
			currency,
			provider: text(meta.source, 32) ?? "unknown",
			method,
			reference: text(meta.reference) ?? text(meta.providerEventId),
			planId: text(meta.planId, 64),
			seats: whole(meta.seats),
			interval,
			periodStart: moment(meta.periodStart),
			periodEnd,
		});
	}
	return { invoices };
}

export async function startTrial(userId: string) {
	const organizationId = await requireOwner(userId);
	requireProvider();
	const transition = await startOrganizationTrial(organizationId, userId);
	if (!transition.applied)
		throw new ORPCError("CONFLICT", {
			message:
				transition.reason === "trial_used"
					? "This organization has already used its trial."
					: "Only an organization on the personal plan can start a trial.",
		});
	const trialEndsAt = transition.subscription.trialEndsAt;
	if (!trialEndsAt) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "The trial has no end date." });
	return { trialEndsAt };
}

export async function createCheckout(
	userId: string,
	input: { planId: string; interval: BillingInterval; seats: number; method?: CheckoutMethod | undefined },
) {
	const organizationId = await requireOwner(userId);
	const provider = requireProvider();
	const plan = await loadPlanPrices(input.planId);
	if (!plan?.active || !isSelfServicePlan(plan.id) || priceFor(plan, input.interval, input.seats, "USD") === null)
		throw new ORPCError("BAD_REQUEST", { message: "This plan cannot be bought online. Contact us." });
	const state = await loadBillingState(organizationId);
	checkSeats(input.seats, state.memberCount, plan.seatLimit);
	const [account] = await db
		.select({ email: schema.user.email })
		.from(schema.user)
		.where(eq(schema.user.id, userId))
		.limit(1);
	if (!account) throw new ORPCError("UNAUTHORIZED", { message: "Sign in again." });
	let result;
	try {
		result = await provider.createCheckout({
			orgId: organizationId,
			planId: plan.id,
			interval: input.interval,
			seats: input.seats,
			customerEmail: account.email,
			returnUrl: returnUrl(),
			// CAREEROS (P3-T05): the chosen way to pay
			...(input.method && { method: input.method }),
		});
	} catch (error) {
		throw providerFailure(error, "This plan cannot be bought online. Contact us.");
	}
	return "redirectUrl" in result
		? { redirectUrl: result.redirectUrl, stkPushRequested: false }
		: { redirectUrl: null, stkPushRequested: true };
}

/** The subscription of an organization that currently pays (active or past due) through the configured provider. */
async function requirePayingSubscription(organizationId: string) {
	const provider = requireProvider();
	const state = await loadBillingState(organizationId);
	const sub = state.subscription;
	if ((sub.status !== "active" && sub.status !== "past_due") || sub.provider !== provider.id || !sub.interval)
		throw new ORPCError("PRECONDITION_FAILED", { message: "The organization has no active subscription to change." });
	return { provider, state, sub, interval: sub.interval };
}

export async function changeSeats(userId: string, input: { seats: number }) {
	const organizationId = await requireOwner(userId);
	const { provider, state, sub, interval } = await requirePayingSubscription(organizationId);
	const plan = await loadPlanPrices(state.planId);
	checkSeats(input.seats, state.memberCount, plan?.seatLimit ?? null);
	try {
		await provider.changeSeats({
			orgId: organizationId,
			planId: state.planId,
			interval,
			seats: input.seats,
			providerSubscriptionId: sub.providerSubscriptionId,
			// CAREEROS (P3-T05): recorded before the provider disables the old subscription (see ChangeSeatsInput)
			onPending: (change) => recordPendingSeatChange(organizationId, change, userId),
		});
	} catch (error) {
		throw providerFailure(error, "The payment provider does not support changing seats here.");
	}
	return { accepted: true };
}

export async function cancelSubscription(userId: string) {
	const organizationId = await requireOwner(userId);
	const { provider, sub } = await requirePayingSubscription(organizationId);
	try {
		await provider.cancel({
			orgId: organizationId,
			providerSubscriptionId: sub.providerSubscriptionId,
			periodEnd: sub.periodEnd,
		});
	} catch (error) {
		throw providerFailure(error, "The payment provider does not support cancelling here.");
	}
	return { accepted: true };
}

export async function customerPortal(userId: string) {
	const organizationId = await requireOwner(userId);
	const provider = requireProvider();
	const state = await loadBillingState(organizationId);
	let url;
	try {
		url = await provider.customerPortalUrl({
			orgId: organizationId,
			providerCustomerId: state.subscription.providerCustomerId,
			providerSubscriptionId: state.subscription.providerSubscriptionId,
			returnUrl: returnUrl(),
		});
	} catch (error) {
		throw providerFailure(error, "The payment provider has no billing portal.");
	}
	if (!url) throw new ORPCError("PRECONDITION_FAILED", { message: "The payment provider has no billing portal." });
	return { url };
}

export { TRIAL_PLAN_ID };
