import { type ReminderDelivery, runRenewalReminders } from "@careeros/billing";
import { buildEmailContext } from "@reactive-resume/auth/email-brand";
import { renewalReminderCopy } from "@reactive-resume/email/billing-strings";
import { renewalReminderMessage } from "@reactive-resume/email/renewal";
import { sendEmail } from "@reactive-resume/email/transport";

// CAREEROS (P3-T05): sends the renewal reminder of a plan paid one period at a time (see packages/billing/src/reminders.ts
// for when and how often). The email is branded for the organization like every other organization email (P2-T04) and
// links to the billing page on the platform host, where the owner pays the next period.

/** Where the owner pays. The billing page itself is P3-T06's; the link is a path on the platform host. */
export const BILLING_PAGE_PATH = "/dashboard/settings/billing";

const formatDate = (date: Date) =>
	new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);

export async function sendRenewalReminder(delivery: ReminderDelivery): Promise<void> {
	const mail = await buildEmailContext({ source: "organization", organizationId: delivery.orgId });
	const copy = renewalReminderCopy(delivery.kind, {
		appName: mail.brand.appName,
		organizationName: delivery.organizationName,
		endDate: `${formatDate(delivery.periodEnd)} (UTC)`,
	});
	const url = new URL(BILLING_PAGE_PATH, mail.linkOrigin).toString();
	const message = renewalReminderMessage({ url, copy, brand: mail.brand });
	for (const to of delivery.ownerEmails)
		await sendEmail({ to, ...message, fromName: mail.fromName, replyTo: mail.replyTo });
}

/** One pass over the organizations whose M-Pesa-paid period is about to end. */
export const runScheduledRenewalReminders = (now?: Date) =>
	runRenewalReminders({ send: sendRenewalReminder, ...(now && { now }) });
