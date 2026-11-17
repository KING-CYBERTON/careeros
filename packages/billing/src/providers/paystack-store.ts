import type { BillingInterval } from "@reactive-resume/db/schema";
import { withOrgContext } from "@careeros/tenancy";
import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { loadBillingState } from "../store";

// CAREEROS (P3-T05): the database side of the Paystack adapter. The provider plan cache is reached only through definer
// functions (the app role has no privilege on the table), and an organization is looked up by a provider code only
// through `careeros_billing_org_by_provider_ref`, which answers with an organization id and nothing else.

export type ProviderPlanKey = {
	planId: string;
	interval: BillingInterval;
	currency: string;
	seats: number;
	/** The provider's smallest unit. */
	amount: number;
};

export type ProviderPlanRow = ProviderPlanKey;

/** What the adapter needs from the database. Tests replace it; the default talks to PostgreSQL. */
export type PaystackStore = {
	getPlanCode(key: ProviderPlanKey): Promise<string | null>;
	/** Caches a plan code and returns the code that is cached for the key (an earlier one wins). */
	putPlanCode(key: ProviderPlanKey, code: string): Promise<string>;
	planByCode(code: string): Promise<ProviderPlanRow | null>;
	/** The one organization a code (from a verified event) belongs to, or null. */
	resolveOrg(ref: { subscriptionCode?: string | null; customerCode?: string | null }): Promise<string | null>;
	/** The end of the period the organization has paid for, or null. Called only with a verified organization id. */
	currentPeriodEnd(orgId: string): Promise<Date | null>;
};

const PROVIDER = "paystack";

export const databasePaystackStore: PaystackStore = {
	async getPlanCode(key) {
		const { rows } = await db.execute<{ code: string | null }>(
			sql`select careeros_billing_provider_plan_get(${PROVIDER}, ${key.planId}, ${key.interval}, ${key.currency}, ${key.seats}, ${key.amount}) as code`,
		);
		return rows[0]?.code ?? null;
	},

	async putPlanCode(key, code) {
		const { rows } = await db.execute<{ code: string }>(
			sql`select careeros_billing_provider_plan_put(${PROVIDER}, ${key.planId}, ${key.interval}, ${key.currency}, ${key.seats}, ${key.amount}, ${code}) as code`,
		);
		return rows[0]?.code ?? code;
	},

	async planByCode(code) {
		const { rows } = await db.execute<{
			plan_id: string;
			billing_interval: BillingInterval;
			currency: string;
			seats: number;
			amount: string | number;
		}>(sql`select * from careeros_billing_provider_plan_by_code(${PROVIDER}, ${code})`);
		const row = rows[0];
		return row
			? {
					planId: row.plan_id,
					interval: row.billing_interval,
					currency: row.currency,
					seats: Number(row.seats),
					amount: Number(row.amount),
				}
			: null;
	},

	async resolveOrg(ref) {
		const { rows } = await db.execute<{ org: string | null }>(
			sql`select careeros_billing_org_by_provider_ref(${PROVIDER}, ${ref.subscriptionCode ?? null}, ${ref.customerCode ?? null}) as org`,
		);
		return rows[0]?.org ?? null;
	},

	async currentPeriodEnd(orgId) {
		return await withOrgContext(orgId, async () => (await loadBillingState(orgId)).subscription.periodEnd);
	},
};
