import type { PendingSeatChange } from "./providers/types";
import { withOrgContext } from "@careeros/tenancy";
import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { audit } from "./audit";
import { lockOrganizationBilling } from "./store";

// CAREEROS (P3-T05): records a seat change that starts with the next paid period (Paystack: a new subscription for the
// new seat count starts when the paid period ends; M-Pesa: the next payment is made for the new count). The payment for
// that count clears the record (state.ts). The organization is the caller's own, resolved from the session by the API.

/** Writes the pending change on the organization's subscription and audits it, in the organization's scope. */
export async function recordPendingSeatChange(
	orgId: string,
	change: PendingSeatChange,
	actorUserId: string,
): Promise<void> {
	await withOrgContext(orgId, () =>
		db.transaction(async () => {
			await lockOrganizationBilling(orgId);
			const fields = { pending_seats: change.seats, pending_replaces_subscription_id: change.replacesSubscriptionId };
			await db.execute(
				sql`select careeros_set_subscription(${orgId}, ${JSON.stringify(fields)}::jsonb, ${actorUserId}, ${"seat_change"})`,
			);
			await audit(
				{ actorUserId },
				"billing.seat_change_pending",
				{ type: "subscription", id: orgId },
				{
					seats: change.seats,
					replacesProviderSubscription: change.replacesSubscriptionId !== null,
				},
			);
		}),
	);
}
