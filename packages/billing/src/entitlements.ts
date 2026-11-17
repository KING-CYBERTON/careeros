import { withOrgContext } from "@careeros/tenancy";
import { and, count, eq, gt } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { BillingError } from "./errors";
import { DISCOVERY_AI_TOP_N_KEY, resolveFeatures, type FeatureKey } from "./features";
import { memoizeInRequest } from "./request-cache";

// CAREEROS (P3-T01, phase plan D3, D4): the one function that answers "what is this organization allowed right now".
// It only reads. Nothing here enforces anything (that is P3-T02), meters AI (P3-T03) or talks to a provider (P3-T04).

export type Entitlements = {
	planId: string;
	/** The organization's status: `trial`, `active`, `past_due` or `suspended`. */
	status: string;
	/** The effective limit (see `effectiveSeatLimit`). Null means unlimited. */
	seatLimit: number | null;
	/** Members plus pending invitations that have not expired. */
	seatsUsed: number;
	aiCreditsPerSeat: number;
	/** The pooled credits of the organization: `aiCreditsPerSeat` x max(seats paid, members). */
	aiCreditsTotal: number;
	/** Resolved in the D4 order. Every key in `FEATURE_KEYS` is present. */
	features: Record<string, boolean>;
	overageAllowed: boolean;
	/**
	 * CAREEROS (P4-T02): the most jobs one discovery run may send to the model (the plan's cap, GTM-PLAN G3). It comes
	 * from the plan's `features.discovery_ai_top_n` (a whole number from 0 to 50) and is `DEFAULT_DISCOVERY_AI_TOP_N`
	 * when the plan has none.
	 */
	discoveryAiTopN: number;
	/** True while the organization is suspended: it can sign in and export, but not write. */
	readOnly: boolean;
};

export type EntitlementInputs = {
	status: string;
	planId: string;
	/** `plan.seat_limit`; null means unlimited. */
	seatLimit: number | null;
	/** `subscription.status`; `none` when the organization has no subscription row. */
	subscriptionStatus: string;
	/** `subscription.provider`; `none` when the organization has no subscription row. */
	subscriptionProvider: string;
	aiCreditsPerSeat: number;
	planFeatures: Record<string, unknown>;
	/** `subscription.seats`; 1 when the organization has no subscription row. */
	seatsPaid: number;
	overageAllowed: boolean;
	memberCount: number;
	pendingInvitationCount: number;
	orgFlags: ReadonlyMap<string, boolean>;
	globalFlags: ReadonlyMap<string, boolean>;
};

/**
 * Credit pool of an organization (D5): the plan's credits per seat times the larger of the seats it pays for and the
 * members it has. Counting members when they exceed the paid seats means an organization that is over its paid seats
 * never has a smaller pool than the people who use it; the seat limit itself is enforced elsewhere (P3-T02). The AI
 * metering (P3-T03) consumes this number.
 */
export function aiCreditsTotal(aiCreditsPerSeat: number, seatsPaid: number, memberCount: number): number {
	return aiCreditsPerSeat * Math.max(seatsPaid, memberCount);
}

/** The plan cap on AI-matched jobs per discovery run when a plan names none (an automation's own `ai_top_n` defaults to 10). */
export const DEFAULT_DISCOVERY_AI_TOP_N = 25;

/** The cap from a plan's `features`: a whole number from 0 to 50, else the default. */
export function discoveryAiTopNCap(planFeatures: Record<string, unknown>): number {
	const value = planFeatures[DISCOVERY_AI_TOP_N_KEY];
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 50
		? value
		: DEFAULT_DISCOVERY_AI_TOP_N;
}

/** Length of a trial in days (PRODUCT.md 8.8). The `plan` table has no column for it; T04's state machine uses this. */
export const TRIAL_DAYS = 14;

const LIVE_SUBSCRIPTION_STATUSES: readonly string[] = ["active", "trialing", "past_due"];

/**
 * The seat limit that applies (Q194): the seats the organization pays for (`subscription.seats`) while it has a
 * live subscription, that is a status of active, trialing or past_due with a provider other than `none`. Otherwise
 * the plan's own `seat_limit`, where null means unlimited.
 */
export function effectiveSeatLimit(input: {
	planSeatLimit: number | null;
	seatsPaid: number;
	subscriptionStatus: string;
	subscriptionProvider: string;
}): number | null {
	const live = LIVE_SUBSCRIPTION_STATUSES.includes(input.subscriptionStatus) && input.subscriptionProvider !== "none";
	return live ? input.seatsPaid : input.planSeatLimit;
}

/** Pure part of `getEntitlements`: no database, so the maths and the flag order are unit-testable. */
export function buildEntitlements(input: EntitlementInputs): Entitlements {
	return {
		planId: input.planId,
		status: input.status,
		seatLimit: effectiveSeatLimit({
			planSeatLimit: input.seatLimit,
			seatsPaid: input.seatsPaid,
			subscriptionStatus: input.subscriptionStatus,
			subscriptionProvider: input.subscriptionProvider,
		}),
		seatsUsed: input.memberCount + input.pendingInvitationCount,
		aiCreditsPerSeat: input.aiCreditsPerSeat,
		aiCreditsTotal: aiCreditsTotal(input.aiCreditsPerSeat, input.seatsPaid, input.memberCount),
		features: resolveFeatures({
			orgFlags: input.orgFlags,
			planFeatures: input.planFeatures,
			globalFlags: input.globalFlags,
		}),
		overageAllowed: input.overageAllowed,
		discoveryAiTopN: discoveryAiTopNCap(input.planFeatures),
		readOnly: input.status === "suspended",
	};
}

function loadEntitlements(orgId: string): Promise<Entitlements> {
	// Inside the organization's scope row-level security applies: the subscription and the flags are those of this
	// organization (and the global flags), whatever the caller passed.
	return withOrgContext(orgId, async () => {
		const [org] = await db
			.select({ status: schema.organization.status, planId: schema.organization.planId })
			.from(schema.organization)
			.where(eq(schema.organization.id, orgId))
			.limit(1);
		if (!org) throw new BillingError("org_not_found");

		const [plan] = await db.select().from(schema.plan).where(eq(schema.plan.id, org.planId)).limit(1);
		if (!plan) throw new BillingError("plan_not_found", `Plan ${org.planId} does not exist.`);

		const [subscription] = await db
			.select({
				seats: schema.subscription.seats,
				overage: schema.subscription.aiOverageAllowed,
				status: schema.subscription.status,
				provider: schema.subscription.provider,
			})
			.from(schema.subscription)
			.where(eq(schema.subscription.organizationId, orgId))
			.limit(1);

		const [members] = await db
			.select({ n: count() })
			.from(schema.member)
			.where(eq(schema.member.organizationId, orgId));
		const [invitations] = await db
			.select({ n: count() })
			.from(schema.invitation)
			.where(
				and(
					eq(schema.invitation.organizationId, orgId),
					eq(schema.invitation.status, "pending"),
					gt(schema.invitation.expiresAt, new Date()),
				),
			);

		const flags = await db
			.select({
				organizationId: schema.featureFlag.organizationId,
				key: schema.featureFlag.key,
				enabled: schema.featureFlag.enabled,
			})
			.from(schema.featureFlag);
		const orgFlags = new Map<string, boolean>();
		const globalFlags = new Map<string, boolean>();
		for (const flag of flags) {
			if (flag.organizationId === orgId) orgFlags.set(flag.key, flag.enabled);
			else if (flag.organizationId === null) globalFlags.set(flag.key, flag.enabled);
		}

		return buildEntitlements({
			status: org.status,
			planId: org.planId,
			seatLimit: plan.seatLimit,
			subscriptionStatus: subscription?.status ?? "none",
			subscriptionProvider: subscription?.provider ?? "none",
			aiCreditsPerSeat: plan.aiCreditsPerSeat,
			planFeatures: plan.features,
			seatsPaid: subscription?.seats ?? 1,
			overageAllowed: subscription?.overage ?? false,
			memberCount: members?.n ?? 0,
			pendingInvitationCount: invitations?.n ?? 0,
			orgFlags,
			globalFlags,
		});
	});
}

/**
 * What the organization is allowed right now. Runs inside the organization's scope (`withOrgContext`, which joins the
 * caller's scope when it is for the same organization and refuses another one). Cached for the length of one request
 * when the caller opened `runWithEntitlementsCache`; never across requests.
 */
export function getEntitlements(orgId: string): Promise<Entitlements> {
	return memoizeInRequest(orgId, () => loadEntitlements(orgId));
}

/** Whether one feature is on for the organization (thin wrapper over `getEntitlements`). */
export async function isFeatureEnabled(orgId: string, key: FeatureKey): Promise<boolean> {
	return (await getEntitlements(orgId)).features[key] ?? false;
}
