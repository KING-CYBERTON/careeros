import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { asDate, asDateOrNull } from "./dates";
import { AdminError, databaseMessage, guarded } from "./errors";

// CAREEROS (P3-T07, phase plan D6, D7): typed wrappers around the `careeros_admin_*` definer functions. Each function
// checks INSIDE the database that `actorUserId` is a platform admin with two-factor authentication on, does its work
// and writes its audit row in the same transaction. These wrappers check nothing about the caller: the actor id must be
// the signed-in user's, taken from the session by the server and never from a request body.

const asNumber = (value: unknown): number => (typeof value === "number" ? value : Number(value));

export type OrgListFilters = {
	search?: string | undefined;
	status?: string | undefined;
	planId?: string | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
};

export type AdminOrgSummary = {
	id: string;
	name: string;
	slug: string;
	status: string;
	planId: string;
	planName: string;
	seatsUsed: number;
	/** The effective seat limit; null means unlimited. */
	seatLimit: number | null;
	createdAt: Date;
	lastActiveAt: Date | null;
	/** Platform AI credits used in the current quota period. */
	aiCreditsUsed: number;
};

type OrgRow = {
	org_id: string;
	org_name: string;
	org_slug: string;
	org_status: string;
	org_plan_id: string;
	org_plan_name: string;
	seats_used: number;
	seat_limit: number | null;
	created_at: Date | string;
	last_active_at: Date | string | null;
	ai_credits_used: string | number;
	total_count: string | number;
};

/** One page of organizations. Never returns member names or emails. Writes one platform audit row. */
export function listOrgs(
	actorUserId: string,
	filters: OrgListFilters = {},
): Promise<{ rows: AdminOrgSummary[]; total: number }> {
	return guarded(async () => {
		const { rows } = await db.execute<OrgRow>(
			sql`select * from careeros_admin_list_orgs(${actorUserId}::text, ${filters.search ?? null}::text, ${filters.status ?? null}::text, ${filters.planId ?? null}::text, ${filters.limit ?? 25}::integer, ${filters.offset ?? 0}::integer)`,
		);
		return {
			rows: rows.map((row) => ({
				id: row.org_id,
				name: row.org_name,
				slug: row.org_slug,
				status: row.org_status,
				planId: row.org_plan_id,
				planName: row.org_plan_name,
				seatsUsed: asNumber(row.seats_used),
				seatLimit: row.seat_limit === null ? null : asNumber(row.seat_limit),
				createdAt: asDate(row.created_at),
				lastActiveAt: asDateOrNull(row.last_active_at),
				aiCreditsUsed: asNumber(row.ai_credits_used),
			})),
			// An empty page has no total row; the caller treats it as zero.
			total: rows[0] ? asNumber(rows[0].total_count) : 0,
		};
	});
}

export type AdminOrgDetail = {
	organization: {
		id: string;
		name: string;
		slug: string;
		status: string;
		planId: string;
		createdAt: string;
		statusChangedAt: string | null;
	};
	plan: { id: string; name: string; pricingModel: string; seatLimit: number | null; aiCreditsPerSeat: number };
	subscription: {
		provider: string;
		status: string;
		seats: number;
		billingInterval: string | null;
		currentPeriodStart: string | null;
		currentPeriodEnd: string | null;
		trialEndsAt: string | null;
		graceEndsAt: string | null;
		aiOverageAllowed: boolean;
	} | null;
	seats: { members: number; pendingInvitations: number; used: number; limit: number | null };
	aiUsage: {
		periodStart: string;
		periodEnd: string;
		creditsTotal: number;
		credits: number;
		costUsdMicros: number;
		calls: number;
		byFeature: { feature: string; credits: number; costUsdMicros: number; calls: number }[];
	};
	billingEvents: { provider: string; type: string; outcome: string; receivedAt: string }[];
	owners: { id: string; name: string; email: string }[];
};

/** One organization in full, with its owners' names and emails. Writes `admin.org_viewed` for the organization. */
export function getOrg(actorUserId: string, orgId: string): Promise<AdminOrgDetail> {
	return guarded(async () => {
		const { rows } = await db.execute<{ detail: AdminOrgDetail }>(
			sql`select careeros_admin_get_org(${actorUserId}::text, ${orgId}::text) as detail`,
		);
		const detail = rows[0]?.detail;
		if (!detail) throw new AdminError("not_found", "unknown organization");
		return detail;
	});
}

/** Suspends (`suspended`) or reactivates (`active`) an organization. Returns the status it now has. */
export function setOrgStatus(
	actorUserId: string,
	orgId: string,
	status: "suspended" | "active",
	reason: string,
): Promise<string> {
	return guarded(async () => {
		const { rows } = await db.execute<{ status: string }>(
			sql`select careeros_admin_set_org_status(${actorUserId}::text, ${orgId}::text, ${status}::text, ${reason}::text) as status`,
		);
		return rows[0]?.status ?? status;
	});
}

/** Assigns a plan and, when given, the seats stored on the subscription. */
export function setOrgPlan(
	actorUserId: string,
	orgId: string,
	planId: string,
	seats: number | null,
	reason: string,
): Promise<void> {
	return guarded(async () => {
		await db.execute(
			sql`select careeros_admin_set_org_plan(${actorUserId}::text, ${orgId}::text, ${planId}::text, ${seats}::integer, ${reason}::text)`,
		);
	});
}

/** Allows or stops AI use past the plan's credits (phase plan D5). */
export function setAiOverage(actorUserId: string, orgId: string, allowed: boolean, reason: string): Promise<void> {
	return guarded(async () => {
		await db.execute(
			sql`select careeros_admin_set_ai_overage(${actorUserId}::text, ${orgId}::text, ${allowed}::boolean, ${reason}::text)`,
		);
	});
}

export type ManualPaymentInput = {
	orgId: string;
	planId: string;
	seats: number;
	interval: "month" | "year";
	periodStart: Date;
	periodEnd: Date;
	/** Integer, in the smallest unit of `currency`. */
	amount: number;
	/** Three capital letters. */
	currency: string;
	/** The invoice or bank reference; the same reference for one organization is applied once. */
	reference: string;
};

/** Records a payment received outside a provider. True when applied, false for a reference recorded before. */
export function recordManualPayment(actorUserId: string, input: ManualPaymentInput): Promise<boolean> {
	return guarded(async () => {
		try {
			const { rows } = await db.execute<{ applied: boolean }>(
				sql`select careeros_admin_record_manual_payment(${actorUserId}::text, ${input.orgId}::text, ${input.planId}::text, ${input.seats}::integer, ${input.interval}::text, ${input.periodStart.toISOString()}::timestamptz, ${input.periodEnd.toISOString()}::timestamptz, ${input.amount}::bigint, ${input.currency}::text, ${input.reference}::text) as applied`,
			);
			return rows[0]?.applied === true;
		} catch (error) {
			// T04's function raises with its own prefix; it is a refusal of the input, like ours.
			const text = databaseMessage(error);
			const at = text.indexOf("careeros_record_manual_payment: ");
			if (at >= 0)
				throw new AdminError(
					"invalid",
					(text.slice(at + "careeros_record_manual_payment: ".length).split("\n")[0] ?? "").trim(),
				);
			throw error;
		}
	});
}

export type AdminMetrics = {
	from: string;
	to: string;
	orgsByStatus: Record<string, number>;
	orgsByPlan: Record<string, number>;
	newOrgs: number;
	activeMembers: number;
	/** Minor units per currency (USD cents, KES cents). */
	mrr: { currency: string; amountMinor: number }[];
	revenue: { currency: string; amountMinor: number }[];
	aiCostUsdMicros: number;
	aiCostByOrg: {
		organizationId: string;
		name: string;
		costUsdMicros: number;
		credits: number;
		revenue: { currency: string; amountMinor: number }[];
	}[];
};

/** Counts, MRR, revenue and AI cost for `[from, to)`; the last 30 days when both are omitted. */
export function getMetrics(actorUserId: string, range: { from?: Date | undefined; to?: Date | undefined } = {}) {
	return guarded(async () => {
		const { rows } = await db.execute<{ metrics: AdminMetrics }>(
			sql`select careeros_admin_metrics(${actorUserId}::text, ${range.from?.toISOString() ?? null}::timestamptz, ${range.to?.toISOString() ?? null}::timestamptz) as metrics`,
		);
		const metrics = rows[0]?.metrics;
		if (!metrics) throw new AdminError("invalid", "no metrics");
		return metrics;
	});
}

export type AuditFilters = {
	organizationId?: string | undefined;
	platformOnly?: boolean | undefined;
	action?: string | undefined;
	from?: Date | undefined;
	to?: Date | undefined;
	/** The id of the last entry of the previous page. */
	before?: string | undefined;
	limit?: number | undefined;
};

export type AdminAuditEntry = {
	id: string;
	organizationId: string | null;
	organizationName: string | null;
	actorUserId: string | null;
	impersonatorUserId: string | null;
	action: string;
	targetType: string | null;
	targetId: string | null;
	metadata: Record<string, unknown>;
	createdAt: Date;
};

type AuditRow = {
	entry_id: string;
	organization_id: string | null;
	organization_name: string | null;
	actor_user_id: string | null;
	impersonator_user_id: string | null;
	action: string;
	target_type: string | null;
	target_id: string | null;
	metadata: Record<string, unknown>;
	created_at: Date | string;
};

/** One page of the audit log of every organization and of the platform, newest first. */
export function listAudit(actorUserId: string, filters: AuditFilters = {}): Promise<AdminAuditEntry[]> {
	return guarded(async () => {
		const { rows } = await db.execute<AuditRow>(
			sql`select * from careeros_admin_list_audit(${actorUserId}::text, ${filters.organizationId ?? null}::text, ${filters.platformOnly ?? false}::boolean, ${filters.action ?? null}::text, ${filters.from?.toISOString() ?? null}::timestamptz, ${filters.to?.toISOString() ?? null}::timestamptz, ${filters.before ?? null}::text, ${filters.limit ?? 50}::integer)`,
		);
		return rows.map((row) => ({
			id: row.entry_id,
			organizationId: row.organization_id,
			organizationName: row.organization_name,
			actorUserId: row.actor_user_id,
			impersonatorUserId: row.impersonator_user_id,
			action: row.action,
			targetType: row.target_type,
			targetId: row.target_id,
			metadata: row.metadata,
			createdAt: asDate(row.created_at),
		}));
	});
}

/** Throws an `AdminError` unless the actor is a platform admin with two-factor authentication on. Reads and audits nothing. */
export function assertPlatformAdmin(actorUserId: string): Promise<void> {
	return guarded(async () => {
		await db.execute(sql`select careeros_assert_platform_admin(${actorUserId}::text)`);
	});
}
