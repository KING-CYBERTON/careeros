import { isMailableAddress } from "@careeros/email-templates";

// CAREEROS (P5-T04): the pure parts of filling a template in from an application: which interview and which contact an
// email is about, and how the interview date reads. No database here, so they are unit tested on their own.

/** Each value is cut here, so a template can never grow into a huge text from a long company name. */
export const MAX_VALUE_LENGTH = 200;

export const formatInterview = (at: Date, locale: string | undefined, timeZone: string): string => {
	const options: Intl.DateTimeFormatOptions = {
		weekday: "long",
		day: "numeric",
		month: "long",
		hour: "numeric",
		minute: "2-digit",
	};
	const attempt = (tag: string | undefined, zone: string) =>
		new Intl.DateTimeFormat(tag, { ...options, timeZone: zone }).format(at);
	// An unknown language tag or time zone is a client or profile mistake, not a reason to fail the request.
	for (const [tag, zone] of [
		[locale, timeZone],
		[locale, "UTC"],
		["en", timeZone],
		["en", "UTC"],
	] as const) {
		try {
			return attempt(tag, zone);
		} catch {
			// try the next combination
		}
	}
	return at.toISOString();
};

type Activity = { type: string; at: Date | string };

/** The interview a message is about: the next one still to come, else the most recent one. */
export function pickInterviewDate(activity: readonly Activity[], now = new Date()): Date | null {
	const times = activity
		.filter((entry) => entry.type === "interview")
		.map((entry) => new Date(entry.at))
		.filter((at) => !Number.isNaN(at.getTime()))
		.sort((a, b) => a.getTime() - b.getTime());
	return times.find((at) => at.getTime() >= now.getTime()) ?? times.at(-1) ?? null;
}

type Contact = { name: string; email: string };

/** One contact for the whole email: the first with an address (so the name and the address belong together), else the first. */
export function pickContact(contacts: readonly Contact[]): Contact | null {
	return contacts.find((contact) => isMailableAddress(contact.email)) ?? contacts[0] ?? null;
}
