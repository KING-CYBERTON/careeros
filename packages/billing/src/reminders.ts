import { withOrgContext } from "@careeros/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { audit } from "./audit";
import { isOnePeriodPlan } from "./state";
import { loadBillingState, lockOrganizationBilling } from "./store";

// CAREEROS (P3-T05): renewal reminders for plans paid one period at a time (Paystack with M-Pesa: nothing renews them).
// Owners get one email three days before the paid period ends and one on the last day. A reminder is recorded in the
// organization's audit log (`billing.renewal_reminder_sent`, with the kind and the period end), which is also how a
// second pass, or a second server, knows it was already sent. The record is written only after the email was handed to
// the mail transport, so a failed send is tried again on the next pass.
//
// Like the billing job, the scheduler has no organization: one definer function answers with ids of organizations that
// look due, and each is re-read under its billing lock inside its own scope before anything is sent.

export const REMINDER_ACTION = "billing.renewal_reminder_sent";
const DAY_MS = 24 * 60 * 60 * 1000;

export type ReminderKind = "three_days" | "last_day";

export type ReminderDelivery = {
	orgId: string;
	organizationName: string;
	kind: ReminderKind;
	periodEnd: Date;
	/** Verified owners of the organization. */
	ownerEmails: string[];
};

/** Sends one reminder to the owners. Resolves when the mail was handed over; throws when it could not be. */
export type ReminderSender = (delivery: ReminderDelivery) => Promise<void>;

export type ReminderResult = { due: number; sent: number; skipped: number; failed: number };

/** Which reminder is due `msLeft` before the period ends, or null when none is yet. */
export function reminderKind(msLeft: number): ReminderKind | null {
	if (msLeft <= 0) return null;
	if (msLeft <= DAY_MS) return "last_day";
	if (msLeft <= 3 * DAY_MS) return "three_days";
	return null;
}

export async function runRenewalReminders(options: {
	send: ReminderSender;
	now?: Date;
	provider?: string;
}): Promise<ReminderResult> {
	const now = options.now ?? new Date();
	const provider = options.provider ?? "paystack";
	const { rows } = await db.execute<{ organization_id: string }>(
		sql`select organization_id from careeros_billing_reminder_orgs(${provider}, ${now.toISOString()}::timestamptz)`,
	);
	const result: ReminderResult = { due: rows.length, sent: 0, skipped: 0, failed: 0 };
	for (const { organization_id: orgId } of rows) {
		try {
			const sent = await withOrgContext(orgId, () =>
				db.transaction(async () => {
					await lockOrganizationBilling(orgId);
					const state = await loadBillingState(orgId);
					const sub = state.subscription;
					if (state.orgStatus !== "active" || sub.status !== "active" || !isOnePeriodPlan(sub) || !sub.periodEnd)
						return false;
					const kind = reminderKind(sub.periodEnd.getTime() - now.getTime());
					if (!kind) return false;
					const periodEnd = sub.periodEnd.toISOString();
					const [already] = await db
						.select({ id: schema.auditLog.id })
						.from(schema.auditLog)
						.where(
							and(
								eq(schema.auditLog.action, REMINDER_ACTION),
								sql`${schema.auditLog.metadata}->>'periodEnd' = ${periodEnd}`,
								sql`${schema.auditLog.metadata}->>'kind' = ${kind}`,
							),
						)
						.limit(1);
					if (already) return false;
					const [org] = await db
						.select({ name: schema.organization.name })
						.from(schema.organization)
						.where(eq(schema.organization.id, orgId))
						.limit(1);
					const owners = await db
						.select({ email: schema.user.email, role: schema.member.role })
						.from(schema.member)
						.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
						.where(and(eq(schema.member.organizationId, orgId), eq(schema.user.emailVerified, true)));
					// Better Auth stores several roles as a comma separated list.
					const ownerEmails = owners
						.filter((owner) =>
							owner.role
								.split(",")
								.map((role) => role.trim())
								.includes("owner"),
						)
						.map((owner) => owner.email);
					if (ownerEmails.length === 0) return false;
					await options.send({
						orgId,
						organizationName: org?.name ?? "",
						kind,
						periodEnd: sub.periodEnd,
						ownerEmails,
					});
					await audit(
						{ actorUserId: null },
						REMINDER_ACTION,
						{ type: "subscription", id: orgId },
						{
							source: "job",
							kind,
							periodEnd,
							recipients: ownerEmails.length,
						},
					);
					return true;
				}),
			);
			if (sent) result.sent += 1;
			else result.skipped += 1;
		} catch (error) {
			result.failed += 1;
			console.error(
				`[billing] Renewal reminder failed for organization ${orgId}`,
				error instanceof Error ? error.name : "",
			);
		}
	}
	return result;
}
