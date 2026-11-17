import type { PlunkConfig } from "./plunk";
import type { SendMailOptions, Transporter } from "nodemailer";
import type { ReactElement } from "react";
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { render } from "react-email";
import { env } from "@reactive-resume/env/server";
import { PLATFORM_DEFAULT_APP_NAME } from "@reactive-resume/utils/brand";
import { cleanDisplayName, safeReplyTo } from "./brand";
import { PlunkError, sendWithPlunk } from "./plunk";

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

// CAREEROS (P6-T02): how email leaves the platform. EMAIL_PROVIDER decides; unset means smtp when the SMTP_* variables
// are complete (the upstream behaviour), else log. `plunk` without its settings cannot happen at runtime (the env
// check refuses to start), but the transport still falls back to log rather than send half-configured.
export type EmailProvider = "plunk" | "smtp" | "log";

type ProviderEnv = Pick<
	typeof env,
	"EMAIL_PROVIDER" | "SMTP_HOST" | "SMTP_USER" | "SMTP_PASS" | "SMTP_FROM" | "PLUNK_SECRET_KEY" | "EMAIL_FROM_ADDRESS"
>;

const smtpComplete = (config: ProviderEnv) =>
	Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS && config.SMTP_FROM);

// CAREEROS: P6-T02a - packages/api/src/features/flags/email-configured.ts mirrors this; keep the two in step.
export const resolveEmailProvider = (config: ProviderEnv = env): EmailProvider => {
	if (config.EMAIL_PROVIDER === "plunk") return config.PLUNK_SECRET_KEY && config.EMAIL_FROM_ADDRESS ? "plunk" : "log";
	if (config.EMAIL_PROVIDER) return config.EMAIL_PROVIDER;
	return smtpComplete(config) ? "smtp" : "log";
};

const getPlunkConfig = (): PlunkConfig | undefined => {
	if (!env.PLUNK_SECRET_KEY || !env.EMAIL_FROM_ADDRESS) return;
	return { apiUrl: env.PLUNK_API_URL, secretKey: env.PLUNK_SECRET_KEY, fromAddress: env.EMAIL_FROM_ADDRESS };
};

let cachedTransport: Transporter | undefined;

const getTransport = () => {
	if (resolveEmailProvider() !== "smtp") return;
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

/** What happened to one message. `queued` means the provider accepted it; `logged` means nothing was configured. */
export type DeliveryResult = {
	provider: EmailProvider;
	outcome: "queued" | "suppressed" | "logged" | "failed";
	/** On `failed`: Plunk's error code when it gave one, else the kind of failure (plan_limit, rate_limited, ...). */
	code?: string;
	/** On `failed`: the HTTP status, 0 when there was no response. */
	status?: number;
	/** On `queued` through Plunk: Plunk's id of the email. */
	emailId?: string;
};

/** Logs a failed Plunk call: status, Plunk's error code and request id only, never a body, an address or the key. */
const logPlunkFailure = (error: unknown) => {
	if (error instanceof PlunkError)
		console.error("There was an error sending mail.", {
			provider: "plunk",
			kind: error.kind,
			status: error.status,
			code: error.code,
			requestId: error.requestId,
		});
	else console.error("There was an error sending mail.");
};

/**
 * Whether the address is on the suppression list. The list is read through a definer function; if the database cannot
 * answer, the mail still goes out (an authentication email is worth more than the risk of one more bounce) and the
 * failure is logged without the address.
 */
async function isSuppressed(address: string): Promise<boolean> {
	try {
		const { isEmailSuppressed } = await import("./suppression");
		return await isEmailSuppressed(address);
	} catch {
		console.error("Email suppression check failed; sending anyway.");
		return false;
	}
}

const failureOf = (error: unknown): DeliveryResult => {
	logPlunkFailure(error);
	return error instanceof PlunkError
		? { provider: "plunk", outcome: "failed", code: error.code ?? error.kind, status: error.status }
		: { provider: "plunk", outcome: "failed", code: "unknown", status: 0 };
};

/**
 * Sends one email and says what happened. Never throws for a delivery problem: a failure is logged without secrets and
 * returned. `sendEmail` below is this with the answer dropped; the Super Admin test send shows it.
 */
export const deliverEmail = async ({
	to,
	subject,
	react,
	fromName,
	replyTo,
}: SendEmailOptions): Promise<DeliveryResult> => {
	const provider = resolveEmailProvider();

	if (provider === "plunk") {
		const config = getPlunkConfig();
		if (config) {
			if (await isSuppressed(to)) {
				console.info("Email recipient is suppressed; skipping email send.");
				return { provider, outcome: "suppressed" };
			}
			try {
				const result = await sendWithPlunk(config, {
					to,
					subject: cleanSubject(subject),
					html: await render(react),
					fromName,
					replyTo,
				});
				return { provider, outcome: "queued", ...(result.emailId && { emailId: result.emailId }) };
			} catch (error) {
				return failureOf(error);
			}
		}
	}

	const transport = getTransport();
	if (!transport && process.env.NODE_ENV === "production") {
		console.info("SMTP not configured; skipping email send.", { to, subject });
		return { provider, outcome: "logged" };
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
		return { provider, outcome: "logged" };
	}

	try {
		await transport.sendMail(payload);
		return { provider, outcome: "queued" };
	} catch {
		// SMTP errors can contain credentials or authentication links.
		console.error("There was an error sending mail.");
		return { provider, outcome: "failed", code: "smtp_error", status: 0 };
	}
};

export const sendEmail = async (options: SendEmailOptions): Promise<void> => {
	await deliverEmail(options);
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

const escapeHtml = (value: string) =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The HTML of a career notification through Plunk: the text and one link, all escaped. */
const careerNotificationHtml = (text: string, link: string) =>
	`<p>${escapeHtml(text).replaceAll(/\r?\n/g, "<br>")}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`;

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
	const plunk = resolveEmailProvider() === "plunk" ? getPlunkConfig() : undefined;
	const transport = plunk ? undefined : getTransport();
	if (!plunk && !transport) return false;
	const link = new URL(url, env.APP_URL);
	if (link.origin !== new URL(env.APP_URL).origin)
		throw new Error("Career notification links must point to this application.");

	if (plunk) {
		// CAREEROS (P6-T02): a suppressed address is reported as not delivered (false), like an unconfigured transport, so
		// the member sees the "email failed" notice instead of nothing.
		if (await isSuppressed(to)) {
			console.info("Email recipient is suppressed; skipping email send.");
			return false;
		}
		try {
			// The notification's key makes a retry the same message to Plunk (409, already sent).
			await sendWithPlunk(plunk, {
				to,
				subject: cleanSubject(subject),
				html: careerNotificationHtml(text, link.toString()),
				fromName,
				replyTo,
				idempotencyKey: key,
			});
			return true;
		} catch (error) {
			logPlunkFailure(error);
			throw new Error("Career notification email could not be delivered.");
		}
	}

	try {
		await transport?.sendMail({
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
