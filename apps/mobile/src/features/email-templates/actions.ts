import { buildMailto, copyText } from "@careeros/email-templates";

// CAREEROS (P5-T04): what "Open in mail app" and "Copy" do on the phone. They take the platform calls as arguments so
// the same logic runs in the sheet and in `scripts/email-templates.test.mjs`. The platform never sends the email.

export type EmailText = { to?: string | null | undefined; subject: string; body: string };

export type MailDeps = {
	openURL: (url: string) => Promise<unknown>;
	canOpenURL: (url: string) => Promise<boolean>;
	setString: (text: string) => Promise<unknown>;
};

/** `opened`: the mail app took it. `copied-long`: too long for a link, copied instead. `copied-unavailable`: no mail app. */
export type OpenMailOutcome = "opened" | "copied-long" | "copied-unavailable";

/** Opens the person's mail app on the email, or copies it when the link would be too long or nothing can open it. */
export async function openInMailApp(email: EmailText, deps: MailDeps): Promise<OpenMailOutcome> {
	const mail = buildMailto(email);
	if (mail.mode === "copy") {
		await deps.setString(copyText(email));
		return "copied-long";
	}
	try {
		if (await deps.canOpenURL(mail.url)) {
			await deps.openURL(mail.url);
			return "opened";
		}
	} catch {
		// Fall through to the copy below.
	}
	await deps.setString(copyText(email));
	return "copied-unavailable";
}

/** Puts the subject and the body on the clipboard. */
export async function copyEmail(email: EmailText, deps: Pick<MailDeps, "setString">): Promise<void> {
	await deps.setString(copyText(email));
}
