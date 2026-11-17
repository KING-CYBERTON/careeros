import type { BillingInterval } from "@reactive-resume/db/schema";
import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { BillingError } from "./errors";

// CAREEROS (P3-T04): a payment recorded by a platform admin (an institution paying by invoice). The work is done by the
// definer function `careeros_record_manual_payment`, which applies the same transition as `payment.succeeded` with
// provider `manual` and writes the audit row. The database function refuses an actor who is not a non-banned platform admin; the procedure that calls this is part of P3-T07 (which adds 2FA and host checks);
// this wrapper does not check who the caller is.

export type ManualPaymentInput = {
	orgId: string;
	planId: string;
	seats: number;
	interval: BillingInterval;
	periodStart: Date;
	periodEnd: Date;
	/** Integer, in the smallest unit of `currency` (cents for USD). */
	amount: number;
	/** Three capital letters, for example `USD` or `KES`. */
	currency: string;
	/** The invoice or bank reference. Recording the same reference twice for one organization is a no-op. */
	reference: string;
	/** The platform admin who recorded it. */
	actorUserId: string;
};

/** True when the payment was applied; false when this reference was already recorded for the organization (or is stale). */
export async function recordManualPayment(input: ManualPaymentInput): Promise<boolean> {
	if (!Number.isInteger(input.seats) || input.seats < 1)
		throw new BillingError("invalid_manual_payment", "Seats must be a whole number of at least 1.");
	if (!Number.isInteger(input.amount) || input.amount < 0)
		throw new BillingError("invalid_manual_payment", "The amount must be a whole number of minor units.");
	if (!(input.periodEnd.getTime() > input.periodStart.getTime()))
		throw new BillingError("invalid_manual_payment", "The period must end after it starts.");
	try {
		const { rows } = await db.execute<{ applied: boolean }>(
			sql`select careeros_record_manual_payment(${input.orgId}, ${input.planId}, ${input.seats}, ${input.interval}, ${input.periodStart.toISOString()}::timestamptz, ${input.periodEnd.toISOString()}::timestamptz, ${input.amount}::bigint, ${input.currency}, ${input.reference}, ${input.actorUserId}) as applied`,
		);
		return rows[0]?.applied === true;
	} catch (error) {
		// The function's own message (unknown plan, stale period, bad reference) sits on the driver error's cause.
		const cause = (error as { cause?: unknown }).cause;
		throw new BillingError("invalid_manual_payment", cause instanceof Error ? cause.message : String(error));
	}
}
