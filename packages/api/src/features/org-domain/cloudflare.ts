import { env } from "@reactive-resume/env/server";

// CAREEROS (P2-T06, phase plan D3): a minimal typed client for Cloudflare for SaaS custom hostnames on one zone. The
// API token is only ever put in the Authorization header. It is never logged, never part of an error message, and
// response bodies are never logged: a failure is reported as an HTTP status and Cloudflare's numeric error codes.

const API = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 10_000;
// Only idempotent reads are retried: up to two more attempts, on a network error, a timeout, 429 or 5xx.
const GET_ATTEMPTS = 3;

export type CloudflareConfig = {
	token: string;
	zoneId: string;
	/** Injected in tests; the global `fetch` otherwise. */
	fetch?: typeof fetch | undefined;
	timeoutMs?: number | undefined;
	/** Pause before a retried GET; injected in tests. */
	sleep?: ((ms: number) => Promise<void>) | undefined;
};

export type CustomHostname = {
	id: string;
	hostname: string;
	/** Cloudflare's hostname status (`pending`, `active`, `moved`, `blocked`, `deleted`, ...). */
	status: string;
	/** Cloudflare's certificate status (`pending_validation`, `active`, `validation_timed_out`, ...), when it says. */
	sslStatus: string | null;
};

export type CloudflareFailure = "network" | "timeout" | "http" | "response";

/** A failed call. The message holds the operation, status and error codes only: never the token or a response body. */
export class CloudflareError extends Error {
	override readonly name = "CloudflareError";
	constructor(
		readonly operation: string,
		readonly failure: CloudflareFailure,
		readonly status: number | null,
		readonly codes: readonly number[],
	) {
		super(
			`Cloudflare ${operation} failed (${failure}${status === null ? "" : `, HTTP ${status}`}${
				codes.length > 0 ? `, codes ${codes.join(" ")}` : ""
			})`,
		);
	}

	/** Cloudflare's "duplicate custom hostname" error (1406): the name is already registered in the zone. */
	get isDuplicate(): boolean {
		return this.codes.includes(1406);
	}

	get isNotFound(): boolean {
		return this.status === 404;
	}
}

export type CloudflareClient = {
	create: (hostname: string) => Promise<CustomHostname>;
	get: (id: string) => Promise<CustomHostname>;
	/** The custom hostname registered under exactly this name, if any (recovers an id after a crash between create and save). */
	find: (hostname: string) => Promise<CustomHostname | null>;
	/** Deletes a custom hostname. An already deleted one (404) counts as deleted. */
	delete: (id: string) => Promise<void>;
};

type Envelope = {
	success?: unknown;
	errors?: unknown;
	result?: unknown;
};

function errorCodes(errors: unknown): number[] {
	if (!Array.isArray(errors)) return [];
	return errors.flatMap((entry: unknown) => {
		const code = entry && typeof entry === "object" ? (entry as { code?: unknown }).code : undefined;
		return typeof code === "number" && Number.isInteger(code) ? [code] : [];
	});
}

function toCustomHostname(value: unknown): CustomHostname | null {
	if (!value || typeof value !== "object") return null;
	const record = value as { id?: unknown; hostname?: unknown; status?: unknown; ssl?: unknown };
	if (typeof record.id !== "string" || typeof record.hostname !== "string" || typeof record.status !== "string")
		return null;
	const ssl = record.ssl && typeof record.ssl === "object" ? (record.ssl as { status?: unknown }).status : undefined;
	return {
		id: record.id,
		hostname: record.hostname.toLowerCase(),
		status: record.status,
		sslStatus: typeof ssl === "string" ? ssl : null,
	};
}

/** Logs a failed call: the operation, the HTTP status and Cloudflare's error codes. Nothing else. */
function logFailure(error: CloudflareError) {
	console.warn(
		`[org-domain] Cloudflare ${error.operation} failed: ${error.failure}${error.status === null ? "" : ` HTTP ${error.status}`}${
			error.codes.length > 0 ? ` codes ${error.codes.join(",")}` : ""
		}`,
	);
}

export function createCloudflareClient(config: CloudflareConfig): CloudflareClient {
	const doFetch = config.fetch ?? fetch;
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const base = `${API}/zones/${encodeURIComponent(config.zoneId)}/custom_hostnames`;

	async function attempt(operation: string, method: string, url: string, body?: unknown): Promise<Envelope> {
		let response: Response;
		try {
			response = await doFetch(url, {
				method,
				headers: {
					Authorization: `Bearer ${config.token}`,
					Accept: "application/json",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(timeoutMs),
				redirect: "error",
			});
		} catch (error) {
			const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
			throw new CloudflareError(operation, timedOut ? "timeout" : "network", null, []);
		}
		let envelope: Envelope = {};
		try {
			envelope = (await response.json()) as Envelope;
		} catch {
			// A body that is not JSON: the status alone decides.
		}
		if (!response.ok || envelope.success === false)
			throw new CloudflareError(operation, "http", response.status, errorCodes(envelope.errors));
		return envelope;
	}

	async function request(operation: string, method: string, url: string, body?: unknown): Promise<Envelope> {
		const attempts = method === "GET" ? GET_ATTEMPTS : 1;
		for (let n = 1; ; n++) {
			try {
				return await attempt(operation, method, url, body);
			} catch (error) {
				if (!(error instanceof CloudflareError)) throw error;
				const transient = error.failure !== "http" || error.status === 429 || (error.status ?? 0) >= 500;
				if (n >= attempts || !transient) {
					logFailure(error);
					throw error;
				}
				await sleep(250 * n);
			}
		}
	}

	function single(operation: string, envelope: Envelope): CustomHostname {
		const parsed = toCustomHostname(envelope.result);
		if (!parsed) throw new CloudflareError(operation, "response", null, []);
		return parsed;
	}

	return {
		create: async (hostname) =>
			single("create", await request("create", "POST", base, { hostname, ssl: { method: "http", type: "dv" } })),
		get: async (id) => single("get", await request("get", "GET", `${base}/${encodeURIComponent(id)}`)),
		find: async (hostname) => {
			const envelope = await request("find", "GET", `${base}?hostname=${encodeURIComponent(hostname)}`);
			const list = Array.isArray(envelope.result) ? envelope.result : [];
			for (const entry of list) {
				const parsed = toCustomHostname(entry);
				if (parsed?.hostname === hostname.toLowerCase()) return parsed;
			}
			return null;
		},
		delete: async (id) => {
			try {
				await request("delete", "DELETE", `${base}/${encodeURIComponent(id)}`);
			} catch (error) {
				if (error instanceof CloudflareError && error.isNotFound) return;
				throw error;
			}
		},
	};
}

/** The configured client, or `null` when `CF_SAAS_API_TOKEN`, `CF_ZONE_ID` or `CF_SAAS_CNAME_TARGET` is unset. */
export function getCloudflareClient(): CloudflareClient | null {
	if (!env.CF_SAAS_API_TOKEN || !env.CF_ZONE_ID || !env.CF_SAAS_CNAME_TARGET) return null;
	return createCloudflareClient({ token: env.CF_SAAS_API_TOKEN, zoneId: env.CF_ZONE_ID });
}
