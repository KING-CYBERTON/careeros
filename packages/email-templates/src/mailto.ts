// CAREEROS (P5-T04): "Open in mail app". The platform never sends these emails: it builds a `mailto:` link the
// person's own mail app opens, or tells the screen to copy the text when the link would be too long to be safe.

/** Mail apps and browsers cut off or refuse long links; past this the screen copies instead (spec P5-T04). */
export const MAILTO_MAX_LENGTH = 1800;

export type MailtoResult = { mode: "mailto"; url: string } | { mode: "copy"; reason: "too_long" };

// One plain address: no spaces, commas, angle brackets or quotes, so the recipient part can hold only one address.
const ADDRESS = /^[^\s@,;<>"()[\]\\:]+@[^\s@,;<>"()[\]\\:]+\.[^\s@,;<>"()[\]\\:]+$/;

export const isMailableAddress = (value: string | null | undefined): value is string =>
	typeof value === "string" && ADDRESS.test(value.trim());

/** RFC 6068: a line break in a body is CRLF; any other line break in the subject is a space. */
const encodeBody = (body: string) => encodeURIComponent(body.replace(/\r\n?|\n/g, "\r\n"));

export function buildMailto(input: { to?: string | null | undefined; subject: string; body: string }): MailtoResult {
	const to = isMailableAddress(input.to) ? input.to.trim() : "";
	const subject = input.subject.replace(/\s+/g, " ").trim();
	const url = `mailto:${to ? encodeURIComponent(to).replace(/%40/g, "@") : ""}?subject=${encodeURIComponent(subject)}&body=${encodeBody(input.body)}`;
	return url.length > MAILTO_MAX_LENGTH ? { mode: "copy", reason: "too_long" } : { mode: "mailto", url };
}

/** The text a person pastes into their mail app: the subject on its own line, then the body. */
export const copyText = (input: { subject: string; body: string }): string => `${input.subject}\n\n${input.body}`;
