// CAREEROS (P3-T07, requirement 3): the member-host half of a support (impersonation) session. A platform admin starts it
// on the platform host (`admin.impersonation.start`), which returns a URL on the member's organization host with a
// one-time token in the fragment. The page there posts the token here. Everything is decided from the resolved host:
// this route works only on an organization host, only for a request whose Origin is that host, and the database checks
// the token's hash and expiry, the origin and the organization (one generic failure for every miss).
import type { HostContext } from "@careeros/tenancy";
import { isIP } from "node:net";
import { attachImpersonationSession, redeemImpersonation } from "@careeros/platform-admin";
import { consumeHandoffLimit } from "@reactive-resume/api/features/auth-handoff";
import { auth } from "@reactive-resume/auth/config";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_BODY_BYTES = 4 * 1024;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const failure = (status: number, code: string) => json({ code }, status);

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
	try {
		const text = await request.text();
		if (text.length > MAX_BODY_BYTES) return undefined;
		const body: unknown = JSON.parse(text);
		return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function authCallHeaders(request: Request, trustedClient: string): Headers {
	const headers = new Headers();
	const userAgent = request.headers.get("user-agent");
	if (userAgent) headers.set("user-agent", userAgent);
	if (isIP(trustedClient)) headers.set("X-Real-IP", trustedClient);
	return headers;
}

/** `POST /api/careeros/impersonation/redeem`, on the member's organization host. Ids only in the log, never a token. */
export async function handleImpersonationRedeem(
	request: Request,
	host: HostContext,
	trustedClient: string,
): Promise<Response> {
	if (host.kind !== "org") return failure(404, "not_found");
	// Browsers send Origin on every POST and a cross-site page cannot forge it; it must be this host's own origin.
	if (request.headers.get("origin") !== host.origin) return failure(403, "forbidden_origin");
	if (!(await consumeHandoffLimit("redeem", trustedClient))) return failure(429, "rate_limited");
	const body = await readJson(request);
	if (!body) return failure(400, "invalid_request");

	const redeemed = await redeemImpersonation({
		id: body.id,
		token: body.token,
		targetOrigin: host.origin,
		organizationId: host.organizationId,
	}).catch(() => null);
	if (!redeemed) {
		console.info("[impersonation] redeem outcome=invalid");
		return failure(400, "impersonation_invalid");
	}

	try {
		const created = await auth.api.careerosImpersonationCreateSession({
			body: {
				userId: redeemed.targetUserId,
				organizationId: redeemed.organizationId,
				impersonatorUserId: redeemed.impersonatorUserId,
				expiresAt: redeemed.expiresAt.toISOString(),
			},
			headers: authCallHeaders(request, trustedClient),
			asResponse: true,
		});
		if (!created.ok) throw new Error("session");
		const { sessionId, token } = (await created.clone().json()) as { sessionId?: string; token?: string };
		const attached =
			typeof sessionId === "string" &&
			(await attachImpersonationSession(String(body.id), sessionId, redeemed.targetUserId));
		if (!attached) {
			// No live record for this session: end it at once rather than leave a session the server would refuse anyway.
			if (typeof token === "string") await auth.api.careerosHandoffEndSession({ body: { token } }).catch(() => {});
			throw new Error("attach");
		}
		console.info("[impersonation] redeem outcome=redeemed");
		const response = json({ returnTo: "/dashboard" });
		for (const cookie of created.headers.getSetCookie()) response.headers.append("Set-Cookie", cookie);
		return response;
	} catch {
		// The token is spent already; the admin starts again. Same answer as any other failure.
		console.info("[impersonation] redeem outcome=invalid");
		return failure(400, "impersonation_invalid");
	}
}
