import type { MiddlewareHandler } from "hono";

// CAREEROS (P5-T01): the browser extension (apps/extension) asks an organization's address who it is before the user
// has signed in, with `GET /api/openapi/branding/host`. That route is public and read-only, so the only CORS it needs is
// a read from an extension page. No response carries credentials headers.
// CAREEROS (P5-T02): the Job Clipper sign-in adds four routes, each listed by exact path below: the device flow
// (`/api/auth/device/code`, `/api/auth/device/clipper/token`, `/api/auth/device/clipper/revoke`) and the signed-in check
// (`GET /api/openapi/clipper/whoami`). An extension page that holds host access to the organization's address reaches
// them without CORS; this makes them work too when the browser has not granted (or the member has withdrawn) that access,
// as in the e2e run, where the permission prompt cannot be answered. Nothing else gets CORS, and the token still has to
// be right and host-bound: the answer to a request from an extension origin is the same as to any other.
// CAREEROS (P5-T03): clipping a job adds three more, by exact path: `GET /api/openapi/clipper/find-by-url`,
// `POST /api/openapi/clipper/cleanup` and `POST /api/openapi/applications`. The last path is shared with other methods, but
// the answer carries no `Access-Control-Allow-Credentials` and the request carries no cookie, so only a request with a
// clipper token gets anything an extension page can read, and a clipper token reaches only `applications.create` there.

/** `chrome-extension://<id>` (Chrome, Edge) and `moz-extension://<uuid>` (Firefox): the origins of an extension's pages. */
const EXTENSION_ORIGIN = /^(?:chrome|moz)-extension:\/\/[A-Za-z0-9-]{1,64}$/;

export const EXTENSION_CORS_PATH = "/api/openapi/branding/host";

/** P5-T02: the clipper's own routes and the one method each is called with. */
export const EXTENSION_CLIPPER_CORS_ROUTES: Readonly<Record<string, "GET" | "POST">> = {
	"/api/auth/device/code": "POST",
	"/api/auth/device/clipper/token": "POST",
	"/api/auth/device/clipper/revoke": "POST",
	"/api/openapi/clipper/whoami": "GET",
	// P5-T03: clipping a job. The duplicate check, the optional AI tidy and the save, each by exact path.
	"/api/openapi/clipper/find-by-url": "GET",
	"/api/openapi/clipper/cleanup": "POST",
	"/api/openapi/applications": "POST",
};

type ExtensionCorsOptions = { methods: string; headers: string };

/**
 * The answering origin is echoed (never `*`), `Vary: Origin` keeps caches apart, and `Access-Control-Allow-Credentials`
 * is never sent: the request carries no cookies. A page on any other origin gets no CORS headers, as before.
 */
function extensionCors(options: ExtensionCorsOptions): MiddlewareHandler {
	return async (c, next) => {
		const origin = c.req.header("origin");
		const allowed = origin !== undefined && EXTENSION_ORIGIN.test(origin);

		if (c.req.method === "OPTIONS") {
			if (!allowed) return next();
			return c.body(null, 204, {
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Methods": options.methods,
				"Access-Control-Allow-Headers": options.headers,
				"Access-Control-Max-Age": "600",
				Vary: "Origin",
			});
		}

		await next();
		c.header("Vary", "Origin", { append: true });
		if (allowed) c.header("Access-Control-Allow-Origin", origin);
	};
}

/** Lets an extension page read the host-branding route. */
export const extensionBrandingCors: MiddlewareHandler = extensionCors({
	methods: "GET, OPTIONS",
	headers: "Accept",
});

/** P5-T02: the clipper's device flow and signed-in check. The token travels in `Authorization`, never in a cookie. */
export const extensionClipperCors: MiddlewareHandler = extensionCors({
	methods: "GET, POST, OPTIONS",
	headers: "Accept, Authorization, Content-Type",
});
