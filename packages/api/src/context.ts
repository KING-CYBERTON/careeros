import type { Locale } from "@reactive-resume/utils/locale";
import type { User } from "better-auth";
// CAREEROS: tenant context for every protected procedure (P1-T02)
import { resolveOrgForAuthentication, withOrgContext } from "@careeros/tenancy";
import { ORPCError, os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { auth, verifyOAuthToken } from "@reactive-resume/auth/config";
import { getTrustedOrigins } from "@reactive-resume/auth/trusted-origins";
import { db } from "@reactive-resume/db/client";
import { user } from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";

export type RequestPermission = "read" | "write" | "delete";
export type RequestAuthentication = {
	user: User;
	method: "apiKey" | "bearer" | "session";
	permissions: readonly RequestPermission[];
	/** CAREEROS: the session's active organization; only set for session authentication (P1-T02). */
	activeOrganizationId?: string | null | undefined;
	/** CAREEROS: the verified API key's id; only set for API-key authentication (P1-T02). */
	apiKeyId?: string | undefined;
};

interface ORPCContext {
	locale: Locale;
	reqHeaders: Headers;
	resHeaders?: Headers;
	trustedClient?: string;
	/** Set only by a server adapter after authenticating this request. */
	authentication?: RequestAuthentication | null;
}

const TRUSTED_ORIGINS = getTrustedOrigins(env.APP_URL);
// Public pages on the alias call the same API, including when incidental cookies are present.
if (env.APP_ALIAS_URL) TRUSTED_ORIGINS.push(new URL(env.APP_ALIAS_URL).origin);
const fullPermissions: readonly RequestPermission[] = ["read", "write", "delete"];

async function findActiveUser(id: string): Promise<User | null> {
	const [result] = await db.select().from(user).where(eq(user.id, id)).limit(1);
	if (!result || (result.banned && (!result.banExpires || result.banExpires > new Date()))) return null;
	return result;
}

async function getAuthenticationFromBearerToken(headers: Headers): Promise<RequestAuthentication | null> {
	try {
		const authHeader = headers.get("authorization");
		if (!authHeader?.startsWith("Bearer ")) return null;
		const payload = await verifyOAuthToken(authHeader.slice(7));
		if (!payload.sub) return null;
		const result = await findActiveUser(payload.sub);
		if (!result) return null;
		const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
		const explicitPermissions = scopes.filter((scope) => scope.startsWith("api:"));
		// Existing grants used identity scopes for account-wide access. Explicit
		// application scopes opt into least privilege without breaking those grants.
		const permissions = explicitPermissions.length
			? fullPermissions.filter((permission) => scopes.includes(`api:${permission}`))
			: fullPermissions;
		return { user: result, method: "bearer", permissions };
	} catch {
		return null;
	}
}

async function getAuthenticationFromApiKey(apiKey: string): Promise<RequestAuthentication | null> {
	try {
		const result = await auth.api.verifyApiKey({ body: { key: apiKey } });
		if (!result.key || !result.valid) return null;
		const activeUser = await findActiveUser(result.key.referenceId);
		if (!activeUser) return null;
		const statements: unknown = result.key.permissions;
		const apiPermissions = statements && typeof statements === "object" && "api" in statements ? statements.api : [];
		const permissions =
			statements == null
				? fullPermissions
				: fullPermissions.filter((permission) => Array.isArray(apiPermissions) && apiPermissions.includes(permission));
		return { user: activeUser, method: "apiKey", permissions, apiKeyId: result.key.id };
	} catch {
		return null;
	}
}

/** API key, then OAuth bearer token, then same-origin session cookies. */
export async function resolveAuthenticationFromRequestHeaders(headers: Headers): Promise<RequestAuthentication | null> {
	const apiKey = headers.get("x-api-key");
	if (apiKey) {
		const authentication = await getAuthenticationFromApiKey(apiKey);
		if (authentication) return authentication;
	}
	const bearer = await getAuthenticationFromBearerToken(headers);
	if (bearer) return bearer;
	const origin = headers.get("origin");
	if (
		headers.has("cookie") &&
		((origin && !TRUSTED_ORIGINS.includes(origin)) || headers.get("sec-fetch-site") === "cross-site")
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "This request came from another site. Open Reactive Resume directly and try again.",
		});
	}
	// Do not let Better Auth turn an API key into an unrestricted synthetic session.
	const sessionHeaders = new Headers(headers);
	sessionHeaders.delete("x-api-key");
	sessionHeaders.delete("authorization");
	try {
		const result = await auth.api.getSession({ headers: sessionHeaders, query: { disableCookieCache: true } });
		if (!result?.user) return null;
		const activeUser = await findActiveUser(result.user.id);
		return activeUser
			? {
					user: activeUser,
					method: "session",
					permissions: fullPermissions,
					// CAREEROS: Better Auth's organization plugin stores the active organization on the session (P1-T02)
					activeOrganizationId: (result as { session?: { activeOrganizationId?: string | null } }).session
						?.activeOrganizationId,
				}
			: null;
	} catch {
		return null;
	}
}

export async function resolveUserFromRequestHeaders(headers: Headers): Promise<User | null> {
	return (await resolveAuthenticationFromRequestHeaders(headers))?.user ?? null;
}

const base = os.$context<ORPCContext>();

export const publicProcedure = base
	.route({ spec: (operation) => ({ ...operation, security: [] }) })
	.use(async ({ context, next }) => {
		const authentication =
			context.authentication === undefined
				? await resolveAuthenticationFromRequestHeaders(context.reqHeaders)
				: context.authentication;

		return next({
			context: {
				...context,
				authentication,
				user: authentication?.user ?? null,
			},
		});
	});

/**
 * The scope a route needs. Moving a document to Trash removes it like a delete, so its RPC and REST aliases need
 * `delete` too. MCP tools check the same rule before calling a procedure.
 */
export function requiredPermission(route: { method?: string | undefined; operationId?: string | undefined }) {
	if (route.method === "GET") return "read";
	if (route.method === "DELETE" || /^(delete|bulkDelete|purge|trash)|^putDocumentTrash$/i.test(route.operationId ?? ""))
		return "delete";
	return "write";
}

/**
 * Procedures that act on the signed-in user, not on an organization, and must work without an active organization:
 * profile read/update, API-key list/create/delete and account deletion (all in `features/auth/router.ts`).
 * Everything else uses `protectedProcedure`, which fails closed without an organization.
 */
export const protectedProcedureWithoutOrg = publicProcedure
	.route({
		spec: (operation) => ({ ...operation, security: [{ apiKey: [] }, { bearerAuth: [] }, { cookieAuth: [] }] }),
	})
	.use(({ context, procedure, next }) => {
		if (!context.user) throw new ORPCError("UNAUTHORIZED");
		const permission = requiredPermission(procedure["~orpc"].route);
		if (!context.authentication?.permissions.includes(permission)) {
			context.resHeaders?.set("WWW-Authenticate", `Bearer error="insufficient_scope", scope="api:${permission}"`);
			throw new ORPCError("FORBIDDEN", {
				message: `This credential needs the api:${permission} permission. Use a credential that includes it.`,
			});
		}

		return next({
			context: {
				...context,
				user: context.user,
			},
		});
	});

// CAREEROS: resolves the organization and runs the handler inside withOrgContext (P1-T02)
export const protectedProcedure = protectedProcedureWithoutOrg.use(async ({ context, next }) => {
	const organizationId = context.authentication ? await resolveOrgForAuthentication(context.authentication) : undefined;
	if (!organizationId) throw new ORPCError("FORBIDDEN", { message: "No active organization" });
	return withOrgContext(organizationId, () => Promise.resolve(next({ context: { ...context, organizationId } })));
});
