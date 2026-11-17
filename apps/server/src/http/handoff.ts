// CAREEROS (P2-T05, phase plan D5): social and OIDC sign-in on an organization host through a one-time handoff. Four
// endpoints under /api/careeros/handoff: `begin` and `redeem` on the organization host, `request/:id` and `issue` on
// the platform host. No cookie is ever shared across hosts. The security-relevant rules live here and in
// packages/api/src/features/auth-handoff; the spec is docs/plans/P2-T05-auth-handoff.md.
import type { HostContext } from "@careeros/tenancy";
import { isIP } from "node:net";
import {
	beginHandoff,
	consumeHandoffLimit,
	getHandoffRequest,
	HANDOFF_COOKIE,
	HANDOFF_COOKIE_MAX_AGE_SECONDS,
	HANDOFF_COOKIE_PATH,
	issueHandoff,
	redeemHandoff,
} from "@reactive-resume/api/features/auth-handoff";
import { auth } from "@reactive-resume/auth/config";
import { env } from "@reactive-resume/env/server";

const NO_STORE = { "Cache-Control": "no-store" } as const;
// The fragment carries the token; no Referer may leak the page it lands on.
const REDIRECT_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
const MAX_BODY_BYTES = 4 * 1024;

type Outcome = "begin" | "issued" | "denied" | "invalid" | "redeemed" | "refused" | "rate_limited";

/** Request ids and outcome codes only: never a token, a verifier, a fragment or a handoff URL. */
function log(event: "begin" | "issue" | "redeem", outcome: Outcome, requestId?: unknown) {
	const id = typeof requestId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(requestId) ? requestId : "-";
	console.info(`[handoff] ${event} outcome=${outcome} request=${id}`);
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
	Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
const failure = (status: number, code: string) => json({ code }, status);

/**
 * The browser origin the request claims. Browsers send `Origin` on every POST, same-origin ones included, and a
 * cross-site form or fetch cannot forge it. It must equal the origin of the host the server resolved.
 */
const hasOwnOrigin = (request: Request, origin: string) => request.headers.get("origin") === origin;

function readCookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
	}
	return undefined;
}

/** A host-only cookie: no `Domain`, so it is never sent to another host. */
function handoffCookie(value: string, maxAge: number, secure: boolean): string {
	return [
		`${HANDOFF_COOKIE}=${value}`,
		"HttpOnly",
		...(secure ? ["Secure"] : []),
		"SameSite=Lax",
		`Path=${HANDOFF_COOKIE_PATH}`,
		`Max-Age=${maxAge}`,
	].join("; ");
}

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

/** Headers for a server-side Better Auth call: the trusted client address is the only client-derived value. */
function authCallHeaders(request: Request, trustedClient: string): Headers {
	const headers = new Headers();
	const userAgent = request.headers.get("user-agent");
	if (userAgent) headers.set("user-agent", userAgent);
	if (isIP(trustedClient)) headers.set("X-Real-IP", trustedClient);
	return headers;
}

/** `POST /api/careeros/handoff/begin`, on an organization host. */
export async function handleHandoffBegin(
	request: Request,
	host: HostContext,
	trustedClient: string,
): Promise<Response> {
	// The target origin is the resolved host's, so a forged header or body field cannot name another one.
	if (host.kind !== "org") return failure(404, "handoff_unavailable");
	if (!hasOwnOrigin(request, host.origin)) {
		log("begin", "refused");
		return failure(403, "forbidden_origin");
	}
	if (!(await consumeHandoffLimit("begin", trustedClient))) {
		log("begin", "rate_limited");
		return failure(429, "rate_limited");
	}
	const body = await readJson(request);
	if (!body) return failure(400, "invalid_request");
	const started = await beginHandoff({ host, provider: body.provider, returnTo: body.returnTo });
	if (!started) return failure(400, "invalid_request");
	log("begin", "begin", started.id);
	const url = new URL("/auth/handoff", env.APP_URL);
	url.searchParams.set("request", started.id);
	return json({ url: url.toString() }, 200, {
		"Set-Cookie": handoffCookie(started.verifier, HANDOFF_COOKIE_MAX_AGE_SECONDS, host.origin.startsWith("https:")),
	});
}

/** `GET /api/careeros/handoff/request/:id`, on the platform host: what the sign-in page needs, and nothing else. */
export async function handleHandoffRequest(host: HostContext, id: string, trustedClient: string): Promise<Response> {
	if (host.kind !== "platform") return failure(404, "handoff_unavailable");
	if (!(await consumeHandoffLimit("issue", trustedClient))) return failure(429, "rate_limited");
	const found = await getHandoffRequest(id);
	return found ? json(found) : failure(404, "handoff_invalid");
}

const redirect = (location: string, headers: HeadersInit = {}) =>
	new Response(null, { status: 302, headers: { ...REDIRECT_HEADERS, Location: location, ...headers } });

/** Ends the platform session this flow created, and returns the `Set-Cookie` lines that expire its cookie. */
async function endPlatformSession(token: string, request: Request, trustedClient: string): Promise<string[]> {
	try {
		const response = await auth.api.careerosHandoffEndSession({
			body: { token },
			headers: authCallHeaders(request, trustedClient),
			asResponse: true,
		});
		return response.headers.getSetCookie();
	} catch {
		console.error("[handoff] issue could not end the platform session");
		return [];
	}
}

function withCookies(response: Response, cookies: string[]): Response {
	for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
	return response;
}

/**
 * `GET /api/careeros/handoff/issue?request=<id>`, on the platform host, after the provider's callback. Needs the
 * platform session the callback created, issues a one-time token and sends the browser to the organization host with
 * the token in the URL fragment (a fragment never reaches a server log, a proxy or a Referer header).
 */
export async function handleHandoffIssue(
	request: Request,
	host: HostContext,
	trustedClient: string,
): Promise<Response> {
	if (host.kind !== "platform") return failure(404, "handoff_unavailable");
	const requestId = new URL(request.url).searchParams.get("request");
	const failed = () => redirect("/auth/error?error=handoff_failed");
	if (!(await consumeHandoffLimit("issue", trustedClient))) {
		log("issue", "rate_limited", requestId);
		return failed();
	}
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session || session.user.isAnonymous) {
		log("issue", "invalid", requestId);
		return failed();
	}
	const result = await issueHandoff({
		requestId,
		userId: session.user.id,
		sessionCreatedAt: new Date(session.session.createdAt),
	});
	if (result.kind === "invalid") {
		log("issue", "invalid", requestId);
		return failed();
	}
	const cookies = result.revokePlatformSession
		? await endPlatformSession(session.session.token, request, trustedClient)
		: [];
	if (result.kind === "denied") {
		log("issue", "denied", requestId);
		return withCookies(redirect(new URL("/auth/organization-access", result.targetOrigin).toString()), cookies);
	}
	log("issue", "issued", requestId);
	const fragment = new URLSearchParams({ token: result.token, request: result.requestId });
	return withCookies(
		redirect(`${new URL("/auth/handoff/redeem", result.targetOrigin).toString()}#${fragment.toString()}`),
		cookies,
	);
}

/** `POST /api/careeros/handoff/redeem`, on the organization host. One generic answer for every failed check. */
export async function handleHandoffRedeem(
	request: Request,
	host: HostContext,
	trustedClient: string,
): Promise<Response> {
	if (host.kind !== "org") return failure(400, "handoff_invalid");
	if (!hasOwnOrigin(request, host.origin)) {
		log("redeem", "refused");
		return failure(403, "forbidden_origin");
	}
	if (!(await consumeHandoffLimit("redeem", trustedClient))) {
		log("redeem", "rate_limited");
		return failure(429, "rate_limited");
	}
	const body = await readJson(request);
	const redeemed = body
		? await redeemHandoff({
				host,
				requestId: body.request,
				token: body.token,
				verifier: readCookie(request, HANDOFF_COOKIE),
			})
		: null;
	if (!redeemed) {
		log("redeem", "invalid", body?.request);
		return failure(400, "handoff_invalid");
	}

	let created: Response;
	try {
		created = await auth.api.careerosHandoffCreateSession({
			body: { userId: redeemed.userId, organizationId: redeemed.organizationId },
			headers: authCallHeaders(request, trustedClient),
			asResponse: true,
		});
	} catch {
		// The token is spent already, so the person starts again. Same answer as any other failure.
		log("redeem", "invalid", body?.request);
		return failure(400, "handoff_invalid");
	}
	log("redeem", "redeemed", body?.request);
	const response = json({ returnTo: redeemed.returnTo });
	// The session cookie Better Auth set for this host (no Domain), then the verifier cookie cleared.
	for (const cookie of created.headers.getSetCookie()) response.headers.append("Set-Cookie", cookie);
	response.headers.append("Set-Cookie", handoffCookie("", 0, host.origin.startsWith("https:")));
	return response;
}
