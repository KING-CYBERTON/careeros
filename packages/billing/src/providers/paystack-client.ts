// CAREEROS (P3-T05): a small typed HTTP client for Paystack's API (https://paystack.com/docs/api/). One request, one
// timeout, no retries: a POST that is retried can charge or create twice, so the caller decides what a failure means.
//
// Never logs and never puts into an error message: the secret key, a card detail, or a response body. A failed call says
// what Paystack said in its own `message` field (plain text meant for the merchant), cut short, and nothing else.

export const PAYSTACK_API_URL = "https://api.paystack.co";
export const PAYSTACK_TIMEOUT_MS = 15_000;

export class PaystackError extends Error {
	constructor(
		message: string,
		/** The HTTP status Paystack answered with, or null when no answer came (network, timeout). */
		readonly status: number | null,
	) {
		super(message);
		this.name = "PaystackError";
	}

	/** True when asking again later may work: no answer, a rate limit, or a server error. */
	get retryable(): boolean {
		return this.status === null || this.status === 429 || this.status >= 500;
	}
}

export type PaystackClient = {
	get<T>(path: string): Promise<T>;
	post<T>(path: string, body: Record<string, unknown>): Promise<T>;
};

export type PaystackClientOptions = {
	secretKey: string;
	baseUrl?: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Paystack's own message, one line, short. Falls back to the status when there is none. */
function readableMessage(body: unknown, status: number): string {
	const message = isRecord(body) && typeof body.message === "string" ? body.message : "";
	const clean = message
		// eslint-disable-next-line no-control-regex -- strips control characters from a provider text.
		.replaceAll(/[\u0000-\u001f\u007f]+/g, " ")
		.trim()
		.slice(0, 200);
	return clean ? `Paystack refused the request: ${clean}` : `Paystack answered with status ${status}.`;
}

export function createPaystackClient(options: PaystackClientOptions): PaystackClient {
	const baseUrl = options.baseUrl ?? PAYSTACK_API_URL;
	const timeoutMs = options.timeoutMs ?? PAYSTACK_TIMEOUT_MS;
	const doFetch = options.fetch ?? globalThis.fetch;

	async function call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let response: Response;
		try {
			response = await doFetch(`${baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${options.secretKey}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				...(body !== undefined && { body: JSON.stringify(body) }),
				signal: controller.signal,
				redirect: "error",
			});
		} catch (error) {
			// The reason can include the URL or headers of the request, so only a fixed sentence goes up.
			throw new PaystackError(
				error instanceof Error && error.name === "AbortError"
					? "Paystack did not answer in time."
					: "Paystack could not be reached.",
				null,
			);
		} finally {
			clearTimeout(timer);
		}
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			throw new PaystackError(
				`Paystack answered with status ${response.status} and no readable body.`,
				response.status,
			);
		}
		if (!response.ok || !isRecord(parsed) || parsed.status !== true)
			throw new PaystackError(readableMessage(parsed, response.status), response.status);
		return parsed.data as T;
	}

	return {
		get: (path) => call("GET", path),
		post: (path, body) => call("POST", path, body),
	};
}
