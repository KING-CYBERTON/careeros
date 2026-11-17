import { withOrgContext } from "@careeros/tenancy";
import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { nextState } from "./state";
import { applyTransition, loadBillingState, lockOrganizationBilling } from "./store";

// CAREEROS (P3-T04): the periodic billing job. It suspends organizations whose trial or grace period has ended and ends
// canceled subscriptions at the end of the paid period. The scheduler has no organization, so one definer function
// answers with the ids of organizations that look due (ids only, never row data); each organization is then re-read and
// decided under its billing lock inside its own scope. That makes the job idempotent and safe to run on several server
// instances at once: the second pass finds nothing due.

export type BillingJobResult = { due: number; changed: number; failed: number };

/** The database's clock, so instances with drifting clocks agree on what is due. */
async function databaseNow(): Promise<Date> {
	const { rows } = await db.execute<{ now: Date }>(sql`select now() as now`);
	// The driver may hand back a Date or a string, depending on the type parsers in force.
	return rows[0]?.now ? new Date(rows[0].now) : new Date();
}

export async function runBillingJobs(options: { now?: Date } = {}): Promise<BillingJobResult> {
	const now = options.now ?? (await databaseNow());
	const { rows } = await db.execute<{ organization_id: string }>(
		sql`select organization_id from careeros_billing_due_orgs(${now.toISOString()}::timestamptz)`,
	);
	const result: BillingJobResult = { due: rows.length, changed: 0, failed: 0 };
	for (const { organization_id: orgId } of rows) {
		try {
			const applied = await withOrgContext(orgId, () =>
				db.transaction(async () => {
					await lockOrganizationBilling(orgId);
					const transition = nextState(await loadBillingState(orgId), { type: "time.passed" }, now);
					await applyTransition(orgId, transition, { source: "job", actorUserId: null, reason: "billing_job" });
					return transition.applied;
				}),
			);
			if (applied) result.changed += 1;
		} catch (error) {
			result.failed += 1;
			console.error(`[billing] Scheduled work failed for organization ${orgId}`, error);
		}
	}
	return result;
}
