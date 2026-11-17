import type { BillingEvent } from "./events";
import { withOrgContext } from "@careeros/tenancy";
import { eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { BillingError } from "./errors";
import { nextState } from "./state";
import { applyTransition, loadBillingState, lockOrganizationBilling } from "./store";

// CAREEROS (P3-T04, phase plan D9): applying one VERIFIED provider event. Callers verify the signature first
// (`BillingProvider.verifyWebhook`); this function trusts its argument and so must never be handed anything else.
//
// One transaction per event, in the organization's scope, under the organization's billing lock:
//   read the state -> compute the transition (pure) -> record the event (a duplicate stops here) -> write the transition.
// A failure rolls all of it back, including the event record, so the provider's retry is processed afresh; the failure
// itself is then written as an `error` row (which a retry replaces).

export type IntakeOutcome = "applied" | "duplicate" | "ignored";
export type IntakeResult = { outcome: IntakeOutcome; reason: string | null };

type RecordOutcome = "applied" | "ignored" | "error";

/** `careeros_record_billing_event`: true when this event is new (or replaces an `error` record), false for a duplicate. */
async function recordEvent(
	event: Pick<BillingEvent, "provider" | "providerEventId" | "orgId" | "type">,
	outcome: RecordOutcome,
	error: string | null,
): Promise<boolean> {
	const { rows } = await db.execute<{ fresh: boolean }>(
		sql`select careeros_record_billing_event(${event.provider}, ${event.providerEventId}, ${event.orgId}, ${event.type}, ${outcome}, ${error}) as fresh`,
	);
	return rows[0]?.fresh === true;
}

async function organizationExists(orgId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: schema.organization.id })
		.from(schema.organization)
		.where(eq(schema.organization.id, orgId))
		.limit(1);
	return row !== undefined;
}

/** What a failure may say about itself in the record: a short code or message, never a payload. */
const errorText = (error: unknown) =>
	(error instanceof Error ? `${error.name}: ${error.message}` : "unknown error").slice(0, 300);

export async function applyBillingEvent(event: BillingEvent, now: Date = new Date()): Promise<IntakeResult> {
	// Not a tenant read: `organization` is the tenancy table. An organization that does not exist cannot be retried into
	// existence, so a verified event for one is recorded as ignored and answered 200.
	if (!(await organizationExists(event.orgId))) {
		await recordEvent(event, "ignored", "unknown_organization");
		return { outcome: "ignored", reason: "unknown_organization" };
	}
	try {
		return await withOrgContext(event.orgId, () =>
			db.transaction(async (): Promise<IntakeResult> => {
				await lockOrganizationBilling(event.orgId);
				const state = await loadBillingState(event.orgId);
				if (event.planId !== null) {
					const [plan] = await db
						.select({ id: schema.plan.id })
						.from(schema.plan)
						.where(eq(schema.plan.id, event.planId))
						.limit(1);
					if (!plan) throw new BillingError("unknown_plan", `Unknown plan ${event.planId}.`);
				}
				const transition = nextState(state, event, now);
				const outcome: RecordOutcome = transition.applied ? "applied" : "ignored";
				if (!(await recordEvent(event, outcome, transition.applied ? null : transition.reason)))
					return { outcome: "duplicate", reason: null };
				await applyTransition(event.orgId, transition, {
					source: event.provider,
					actorUserId: null,
					reason: event.type,
				});
				return { outcome, reason: transition.reason };
			}),
		);
	} catch (error) {
		// The transaction rolled back, the event is not recorded as applied. Leave a visible trace; a retry replaces it.
		try {
			await recordEvent(event, "error", errorText(error));
		} catch {
			// The trace is best effort: the original failure is the one to report.
		}
		throw error;
	}
}
