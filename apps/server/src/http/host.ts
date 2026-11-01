// CAREEROS (P2-T03): the request host decides the organization. One middleware resolves it once per request.
import type { HostContext } from "@careeros/tenancy";
import type { MiddlewareHandler } from "hono";
import { resolveHost, runWithHost } from "@careeros/tenancy";
import { handleUnknownOrgHost, type ReadWebFile } from "../static/web";

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
			return handleUnknownOrgHost(readWebFile);
		}
		return runWithHost(host, next);
	};
}
