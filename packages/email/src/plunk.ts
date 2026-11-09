import { createHash } from "node:crypto";
import { PLATFORM_DEFAULT_APP_NAME } from "@reactive-resume/utils/brand";
import { cleanDisplayName, safeReplyTo } from "./brand";

// CAREEROS (P6-T02): the Plunk HTTP client. Hosted Plunk has no SMTP relay, so mail goes through `POST /v1/send`.
// The rules, from the spec:
//   * a 10 second timeout, no retries (a second send could mail twice; the caller decides what a failure means);
//   * one `Idempotency-Key` per message (sha256 of a stable key), so the same message sent twice within 24 hours is a
//     409 at Plunk, which is treated as already sent;
//   * `subscribed: false`: a transactional message never adds the recipient to a marketing list;
//   * errors carry the status, Plunk's error code and request id and nothing else: never the request body (an address,
//     a link with a token) and never the key. The code and request id are cut to a safe alphabet before use.

const PLUNK_TIMEOUT_MS = 10_000;

export type PlunkConfig = {
	/** Base address of the API, without a trailing slash. */
	apiUrl: string;
	/** The secret key (sk_...). Server only. */
	secretKey: string;
	/** The verified sending address. */
	fromAddress: string;
};

export type PlunkMessage = {
	to: string;
	subject: string;
	/** HTML. Plunk derives the plain-text part from it. */
	html: string;
	fromName?: string | undefined;
	replyTo?: string | undefined;
	/**
	 * What makes this message the same message when sent again (a career notification's key). Without one, every call
	 * is a new message (a random identifier).
	 */
	idempotencyKey?: string | undefined;
};

export type PlunkResult = {
	/** Plunk's id of the first email it queued, when it returned one. */
	emailId: string | undefined;
	/** The key was already used within 24 hours (HTTP 409): the message was sent before. */
	duplicate: boolean;
};

export type PlunkErrorKind =
	/** 402: the plan's monthly sending cap is reached. */
	| "plan_limit"
	/** 429: the project's rate limit (1000 requests a minute). */
	| "rate_limited"
	/** 5xx. */
	| "server_error"
	/** Any other refusal (a bad key, an unverified domain, a bad body). */
	| "rejected"
	/** The request did not complete within the timeout. */
	| "timeout"
	/** The request could not be made (DNS, connection). */
	| "network";

export class PlunkError extends Error {
	readonly kind: PlunkErrorKind;
	/** HTTP status, 0 when there was no response. */
	readonly status: number;
	/** Plunk's error code, cut to a safe alphabet; undefined when it gave none. */
	readonly code: string | undefined;
	readonly requestId: string | undefined;

	constructor(kind: PlunkErrorKind, status: number, code?: string, requestId?: string) {
		super(`Plunk request failed (${kind}, status ${status}${code ? `, code ${code}` : ""}).`);
		this.name = "PlunkError";
		this.kind = kind;
		this.status = status;
		this.code = code;
		this.requestId = requestId;
	}
}

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const safeToken = (value: unknown): string | undefined =>
	typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;

/** The header value for a message: sha256 hex of the stable key (a random one when there is none). */
export const idempotencyHeader = (key?: string): string =>
	createHash("sha256")
		.update(key ?? crypto.randomUUID())
		.digest("hex");

const kindOf = (status: number): PlunkErrorKind => {
	if (status === 402) return "plan_limit";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "server_error";
	return "rejected";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads Plunk's `{ success: false, error: { code, message, statusCode, requestId } }` without trusting its shape. */
async function readError(response: Response): Promise<{ code: string | undefined; requestId: string | undefined }> {
	try {
		const body: unknown = await response.json();
		const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
		return { code: safeToken(error?.code), requestId: safeToken(error?.requestId) };
	} catch {
		return { code: undefined, requestId: undefined };
	}
}

/** The request body Plunk gets. Exported for the tests, which pin its exact shape. */
export function buildPlunkRequest(config: PlunkConfig, message: PlunkMessage) {
	const reply = safeReplyTo(message.replyTo);
	return {
		to: message.to,
		subject: message.subject,
		body: message.html,
		from: { name: cleanDisplayName(message.fromName) || PLATFORM_DEFAULT_APP_NAME, email: config.fromAddress },
		...(reply && { reply }),
		subscribed: false,
	};
}

export async function sendWithPlunk(config: PlunkConfig, message: PlunkMessage): Promise<PlunkResult> {
	let response: Response;
	try {
		response = await fetch(`${config.apiUrl}/v1/send`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.secretKey}`,
				"Content-Type": "application/json",
				"Idempotency-Key": idempotencyHeader(message.idempotencyKey),
			},
			body: JSON.stringify(buildPlunkRequest(config, message)),
			signal: AbortSignal.timeout(PLUNK_TIMEOUT_MS),
		});
	} catch (error) {
		// The error text can hold the address of the server or parts of the request; only its kind is kept.
		const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
		throw new PlunkError(timedOut ? "timeout" : "network", 0);
	}

	if (response.status === 409) {
		await response.body?.cancel();
		return { emailId: undefined, duplicate: true };
	}

	if (!response.ok) {
		const { code, requestId } = await readError(response);
		throw new PlunkError(kindOf(response.status), response.status, code, requestId);
	}

	let emailId: string | undefined;
	try {
		const body: unknown = await response.json();
		const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
		const first = Array.isArray(data?.emails) ? (data.emails[0] as unknown) : undefined;
		emailId = isRecord(first) ? safeToken(first.email) : undefined;
	} catch {
		// A 2xx without a readable body still means Plunk accepted the message.
	}
	return { emailId, duplicate: false };
}
