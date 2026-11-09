import { cleanAppName } from "./brand";

// CAREEROS (P3-T05): the words of the renewal reminder. An organization that pays by M-Pesa pays one period at a time, so
// the platform reminds its owners three days before the paid period ends and again on the last day.
//
// Lingui (Q461): the server has no Lingui setup (its catalogs and extraction cover apps/web only), so the strings live in
// this one catalog, keyed by message id with `{name}` placeholders and one English entry per id, exactly the shape a
// Lingui catalog entry has. Moving them under Lingui later means replacing `translate` with the i18n lookup; no template
// changes.

export const RENEWAL_REMINDER_KINDS = ["three_days", "last_day"] as const;
export type RenewalReminderKind = (typeof RENEWAL_REMINDER_KINDS)[number];

const MESSAGES = {
	"renewal.subject.three_days": "Your {appName} plan ends on {endDate}",
	"renewal.subject.last_day": "Your {appName} plan ends today",
	"renewal.heading.three_days": "Time to pay for the next period",
	"renewal.heading.last_day": "Your plan ends today",
	"renewal.intro.three_days":
		"The paid period for {organizationName} on {appName} ends on {endDate}. M-Pesa pays one period at a time, so it does not renew by itself.",
	"renewal.intro.last_day":
		"The paid period for {organizationName} on {appName} ends today, {endDate}. Pay now to keep working without a break.",
	"renewal.details":
		"If the period passes unpaid, {organizationName} has 7 days of grace before it becomes read-only. Nothing is deleted.",
	"renewal.action": "Pay for the next period",
	"renewal.outro": "Only pay through links from emails sent by {appName}, and sign in to check the amount.",
} as const;

type MessageId = keyof typeof MESSAGES;

/** Fills `{name}` placeholders. Values are plain text; the template escapes them when it renders. */
function translate(id: MessageId, values: Record<string, string> = {}): string {
	return MESSAGES[id].replaceAll(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

export type RenewalReminderCopy = {
	subject: string;
	preview: string;
	heading: string;
	intro: string;
	details: string;
	actionLabel: string;
	outro: string;
};

export function renewalReminderCopy(
	kind: RenewalReminderKind,
	input: { appName?: string | undefined; organizationName: string; endDate: string },
): RenewalReminderCopy {
	const values = {
		appName: cleanAppName(input.appName),
		organizationName: cleanAppName(input.organizationName),
		endDate: input.endDate,
	};
	return {
		subject: translate(`renewal.subject.${kind}`, values),
		preview: translate(`renewal.subject.${kind}`, values),
		heading: translate(`renewal.heading.${kind}`),
		intro: translate(`renewal.intro.${kind}`, values),
		details: translate("renewal.details", values),
		actionLabel: translate("renewal.action"),
		outro: translate("renewal.outro", values),
	};
}
