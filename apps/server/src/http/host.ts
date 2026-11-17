// CAREEROS (P2-T03): the request host decides the organization. One middleware resolves it once per request.
import type { HostContext } from "@careeros/tenancy";
import type { MiddlewareHandler } from "hono";
import { resolveHost, runWithHost } from "@careeros/tenancy";
import { handleUnknownOrgHost, serveWebDistStatic, type ReadWebFile } from "../static/web";

// Files of the built web app that carry no organization data: the fingerprinted bundle, the platform's own pictures and
// fonts, and the icons. They are the same for every host, and the not-set-up page needs them to start. Nothing else is
// let through: not an API path, an upload, a branding asset, a manifest or a public resume.
const STATIC_WEB_FILE =
	/^\/(?:assets|icon|logo|fonts|illustrations|doodles|photos|sounds|templates|opengraph)\/[^?#]+$|^\/(?:favicon\.(?:ico|svg)|apple-touch-icon-180x180\.png|pwa-(?:64x64|192x192|512x512)\.png|maskable-icon-512x512\.png)$/;

export type HostVariables = { host: HostContext };

/**
 * Resolves the host and puts it on the Hono context (`c.get("host")`) and in the request's async scope, so the RPC,
 * OpenAPI and MCP adapters and `protectedProcedure` all see the same answer. A host with the shape of an organization
 * host that no organization answers to gets a 404 (JSON for `/api/*`, the app shell otherwise); every other host
 * continues as before.
 */
export function hostMiddleware(readWebFile?: ReadWebFile): MiddlewareHandler<{ Variables: HostVariables }> {
	return async (c, next) => {
		const host = await resolveHost(c.req.raw);
		c.set("host", host);
		if (host.kind === "unknown" && host.matchesOrgPattern) {
			const pathname = new URL(c.req.url).pathname;
			if (pathname === "/api" || pathname.startsWith("/api/")) {
				return c.json({ defined: false, code: "NOT_FOUND", status: 404, message: "Not found" }, 404, {
					"Cache-Control": "no-store",
				});
			}
			// The not-set-up page is a client-rendered app: it needs the built files to start, and they hold no organization data.
			if (STATIC_WEB_FILE.test(pathname) && serveWebDistStatic && !pathname.includes("..")) {
				const file = await serveWebDistStatic(c, () => Promise.resolve());
				return file ?? new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
			}
			return handleUnknownOrgHost(readWebFile);
		}
		return runWithHost(host, next);
	};
}
