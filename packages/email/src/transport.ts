import type { SendMailOptions, Transporter } from "nodemailer";
import type { ReactElement } from "react";
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { render } from "react-email";
import { env } from "@reactive-resume/env/server";
import { PLATFORM_DEFAULT_APP_NAME } from "@reactive-resume/utils/brand";
import { cleanDisplayName, safeReplyTo } from "./brand";

export { cleanDisplayName, safeReplyTo };

// CAREEROS (P2-T08, P2-T04): the sender display name is the organization's, else the platform's. The address stays
// SMTP_FROM, the verified one. `fromName` and `replyTo` come from organization branding, so both are cleaned here too.
type SendEmailOptions = {
	to: string;
	subject: string;
	react: ReactElement;
	fromName?: string | undefined;
	replyTo?: string | undefined;
};

/** A subject on one line: nodemailer folds long headers, but a name with a line break must not start a new header. */
// eslint-disable-next-line no-control-regex -- header injection guard.
const cleanSubject = (subject: string) => subject.replaceAll(/[\u0000-\u001f\u007f]+/g, " ").trim();

export const withDisplayName = (from: string | undefined, name?: string | null) => {
	if (!from || from.includes("<")) return from;
	return `"${cleanDisplayName(name) || PLATFORM_DEFAULT_APP_NAME}" <${from}>`;
};

/** The domain for generated Message-IDs: the host name of APP_URL, so no upstream domain leaks into headers. */
const messageIdDomain = () => new URL(env.APP_URL).hostname;

let cachedTransport: Transporter | undefined;

const getTransport = () => {
	const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass, SMTP_FROM: from } = env;
	if (!host || !user || !pass || !from) return;

	cachedTransport ??= nodemailer.createTransport({
		host,
		port: env.SMTP_PORT,
		secure: env.SMTP_SECURE,
		requireTLS: true,
		auth: { user, pass },
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 10_000,
	});

	return cachedTransport;
};

export const sendEmail = async ({ to, subject, react, fromName, replyTo }: SendEmailOptions) => {
	const transport = getTransport();
	if (!transport && process.env.NODE_ENV === "production") {
		console.info("SMTP not configured; skipping email send.", { to, subject });
		return;
	}
	const payload: SendMailOptions = {
		to,
		from: withDisplayName(env.SMTP_FROM, fromName),
		...(safeReplyTo(replyTo) && { replyTo: safeReplyTo(replyTo) }),
		subject: cleanSubject(subject),
		html: await render(react),
		text: await render(react, { plainText: true }),
	};

	if (!transport) {
		console.info("SMTP not configured; skipping email send.", {
			to: payload.to,
			subject: payload.subject,
			text: payload.text,
			html: payload.html,
		});
		return;
	}

	try {
		await transport.sendMail(payload);
	} catch {
		// SMTP errors can contain credentials or authentication links.
		console.error("There was an error sending mail.");
	}
};

type SendCareerNotificationOptions = {
	to: string;
	subject: string;
	text: string;
	url: string;
	key: string;
	fromName?: string | undefined;
	replyTo?: string | undefined;
};

/** Owner-only notifications: missing SMTP never logs personal career content. */
export async function sendCareerNotification({
	to,
	subject,
	text,
	url,
	key,
	fromName,
	replyTo,
}: SendCareerNotificationOptions): Promise<boolean> {
	const transport = getTransport();
	if (!transport) return false;
	const link = new URL(url, env.APP_URL);
	if (link.origin !== new URL(env.APP_URL).origin)
		throw new Error("Career notification links must point to this application.");
	try {
		await transport.sendMail({
			to,
			from: withDisplayName(env.SMTP_FROM, fromName),
			...(safeReplyTo(replyTo) && { replyTo: safeReplyTo(replyTo) }),
			subject: cleanSubject(subject),
			text: `${text}\n\n${link.toString()}`,
			messageId: `<career-${createHash("sha256").update(key).digest("hex")}@${messageIdDomain()}>`,
		});
		return true;
	} catch {
		// SMTP errors can contain recipient addresses, credentials or message fragments.
		throw new Error("Career notification email could not be delivered.");
	}
}
