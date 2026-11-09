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
import { and, eq } from "drizzle-orm";
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

const returnUrl = () => new URL("/dashboard", env.APP_URL).toString();

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
