import { withOrgContext } from "@careeros/tenancy";
import { and, count, eq, gt } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { BillingError } from "./errors";
import { resolveFeatures, type FeatureKey } from "./features";
import { memoizeInRequest } from "./request-cache";

// CAREEROS (P3-T01, phase plan D3, D4): the one function that answers "what is this organization allowed right now".
// It only reads. Nothing here enforces anything (that is P3-T02), meters AI (P3-T03) or talks to a provider (P3-T04).

export type Entitlements = {
	planId: string;
	/** The organization's status: `trial`, `active`, `past_due` or `suspended`. */
	status: string;
	/** Null means unlimited. */
	seatLimit: number | null;
	/** Members plus pending invitations that have not expired. */
	seatsUsed: number;
	aiCreditsPerSeat: number;
	/** The pooled credits of the organization: `aiCreditsPerSeat` x max(seats paid, members). */
	aiCreditsTotal: number;
	/** Resolved in the D4 order. Every key in `FEATURE_KEYS` is present. */
	features: Record<string, boolean>;
	overageAllowed: boolean;
	/** True while the organization is suspended: it can sign in and export, but not write. */
	readOnly: boolean;
};

export type EntitlementInputs = {
	status: string;
	planId: string;
	seatLimit: number | null;
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

/** Pure part of `getEntitlements`: no database, so the maths and the flag order are unit-testable. */
export function buildEntitlements(input: EntitlementInputs): Entitlements {
	return {
		planId: input.planId,
		status: input.status,
		seatLimit: input.seatLimit,
		seatsUsed: input.memberCount + input.pendingInvitationCount,
		aiCreditsPerSeat: input.aiCreditsPerSeat,
		aiCreditsTotal: aiCreditsTotal(input.aiCreditsPerSeat, input.seatsPaid, input.memberCount),
		features: resolveFeatures({
			orgFlags: input.orgFlags,
			planFeatures: input.planFeatures,
			globalFlags: input.globalFlags,
		}),
		overageAllowed: input.overageAllowed,
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
			.select({ seats: schema.subscription.seats, overage: schema.subscription.aiOverageAllowed })
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
