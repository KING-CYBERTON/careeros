import type { MiddlewareHandler } from "hono";

// CAREEROS (P5-T01): the browser extension (apps/extension) asks an organization's address who it is before the user
// has signed in, with `GET /api/openapi/branding/host`. That route is public and read-only, so the only CORS it needs is
// a read from an extension page. Nothing here applies to any other route, and no response carries credentials headers.

/** `chrome-extension://<id>` (Chrome, Edge) and `moz-extension://<uuid>` (Firefox): the origins of an extension's pages. */
const EXTENSION_ORIGIN = /^(?:chrome|moz)-extension:\/\/[A-Za-z0-9-]{1,64}$/;

export const EXTENSION_CORS_PATH = "/api/openapi/branding/host";

/**
 * Lets an extension page read the host-branding route. The answering origin is echoed (never `*`), `Vary: Origin` keeps
 * caches apart, and `Access-Control-Allow-Credentials` is never sent: the request carries no cookies. A page on any
 * other origin gets no CORS headers, as before.
 */
export const extensionBrandingCors: MiddlewareHandler = async (c, next) => {
	const origin = c.req.header("origin");
	const allowed = origin !== undefined && EXTENSION_ORIGIN.test(origin);

	if (c.req.method === "OPTIONS") {
		if (!allowed) return next();
		return c.body(null, 204, {
			"Access-Control-Allow-Origin": origin,
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Access-Control-Allow-Headers": "Accept",
			"Access-Control-Max-Age": "600",
			Vary: "Origin",
		});
	}

	await next();
	c.header("Vary", "Origin", { append: true });
	if (allowed) c.header("Access-Control-Allow-Origin", origin);
};
