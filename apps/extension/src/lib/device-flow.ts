// CAREEROS (P5-T02, phase plan G6): the OAuth 2.0 device authorization flow against the organization the extension is
// connected to (RFC 8628). Pure logic around an injectable `fetch`, so it is tested without a browser. Nothing here
// sends a cookie: every request is `credentials: "omit"`, and the token is only ever sent to the stored origin.

export const CLIPPER_CLIENT_ID = "careeros-job-clipper";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** A flow that is waiting for the member to approve in a browser tab. Kept in storage so it survives a closed popup. */
export type DeviceFlow = {
	origin: string;
	deviceCode: string;
	userCode: string;
	/** Seconds between polls, as the server asked. */
	interval: number;
	/** Epoch milliseconds. */
	expiresAt: number;
};

export type FlowStart = { ok: true; flow: DeviceFlow } | { ok: false; reason: "unreachable" | "unsupported" };

export type PollResult =
	| { kind: "pending" }
	| { kind: "slow_down" }
	| { kind: "approved"; token: string; userName: string; expiresInSeconds: number }
	| { kind: "denied" }
	| { kind: "expired" }
	| { kind: "failed" };

type Fetch = typeof fetch;

const post = (fetcher: Fetch, url: string, body: unknown) =>
	fetcher(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		credentials: "omit",
		redirect: "error",
		cache: "no-store",
	});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Asks the organization for a device code and a user code. */
export async function startDeviceFlow(origin: string, fetcher: Fetch = fetch, now = Date.now()): Promise<FlowStart> {
	let response: Response;
	try {
		response = await post(fetcher, `${origin}/api/auth/device/code`, { client_id: CLIPPER_CLIENT_ID });
	} catch {
		return { ok: false, reason: "unreachable" };
	}
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok || !isRecord(body))
		return { ok: false, reason: response.status === 400 ? "unsupported" : "unreachable" };
	const { device_code: deviceCode, user_code: userCode, interval, expires_in: expiresIn } = body;
	if (typeof deviceCode !== "string" || typeof userCode !== "string") return { ok: false, reason: "unreachable" };
	return {
		ok: true,
		flow: {
			origin,
			deviceCode,
			userCode,
			interval: typeof interval === "number" && interval >= 1 ? interval : 5,
			expiresAt: now + (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 600) * 1000,
		},
	};
}

/** One poll of the token endpoint. */
export async function pollDeviceFlow(flow: DeviceFlow, fetcher: Fetch = fetch, now = Date.now()): Promise<PollResult> {
	if (now >= flow.expiresAt) return { kind: "expired" };
	let response: Response;
	try {
		response = await post(fetcher, `${flow.origin}/api/auth/device/clipper/token`, {
			grant_type: GRANT_TYPE,
			device_code: flow.deviceCode,
			client_id: CLIPPER_CLIENT_ID,
		});
	} catch {
		// A dropped connection is not the end of the sign-in; the next poll tries again.
		return { kind: "pending" };
	}
	const body: unknown = await response.json().catch(() => null);
	if (response.ok) {
		if (isRecord(body) && typeof body.access_token === "string" && body.access_token !== "") {
			return {
				kind: "approved",
				token: body.access_token,
				userName: typeof body.user_name === "string" ? body.user_name.slice(0, 120) : "",
				expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 0,
			};
		}
		return { kind: "failed" };
	}
	const error = isRecord(body) ? body.error : undefined;
	switch (error) {
		case "authorization_pending":
			return { kind: "pending" };
		case "slow_down":
			return { kind: "slow_down" };
		case "access_denied":
			return { kind: "denied" };
		case "expired_token":
			return { kind: "expired" };
		default:
			return { kind: "failed" };
	}
}

/** Seconds to wait before the next poll: the server's interval, and 5 seconds more after each `slow_down`. */
export function nextPollDelaySeconds(interval: number, slowDowns: number): number {
	return Math.max(1, interval) + 5 * slowDowns;
}

/** "ABCD2345" shown as "ABCD-2345". */
export function formatUserCode(userCode: string): string {
	const code = userCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
	return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** The page where the member approves: always the connected organization's own address. */
export function approvalUrl(origin: string, userCode: string): string {
	return `${origin}/device?user_code=${encodeURIComponent(userCode)}`;
}
