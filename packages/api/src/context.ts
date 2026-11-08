import type { Locale } from "@reactive-resume/utils/locale";
import type { User } from "better-auth";
// CAREEROS (P3-T02): one request-scoped entitlements cache, opened per protected procedure
import { runWithEntitlementsCache } from "@careeros/billing";
// CAREEROS (P3-T07): a support session is live only while its record is; some procedures refuse it
import { isImpersonationActive } from "@careeros/platform-admin";
import { isRefusedWhileImpersonating } from "@careeros/platform-admin/policy";
// CAREEROS: tenant context for every protected procedure (P1-T02)
import {
	currentHost,
	ORG_CONTEXT_REQUIRED,
	resolveOrgForAuthentication,
	TenancyError,
	withOrgContext,
	type HostContext,
} from "@careeros/tenancy";
import { ORPCError, os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { auth, verifyOAuthToken } from "@reactive-resume/auth/config";
import { getTrustedOrigins } from "@reactive-resume/auth/trusted-origins";
import { db } from "@reactive-resume/db/client";
import { user } from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";
// CAREEROS (P3-T02): suspended organizations are read-only (phase plan D3)
import { enforceOrganizationStatus } from "./middleware/entitlements";

export type RequestPermission = "read" | "write" | "delete";
export type RequestAuthentication = {
	user: User;
	method: "apiKey" | "bearer" | "session";
	permissions: readonly RequestPermission[];
	/** CAREEROS: the session's active organization; only set for session authentication (P1-T02). */
	activeOrganizationId?: string | null | undefined;
	/** CAREEROS: the verified API key's id; only set for API-key authentication (P1-T02). */
	apiKeyId?: string | undefined;
	/** CAREEROS (P3-T07): the Better Auth session id; only set for session authentication. */
	sessionId?: string | undefined;
	/** CAREEROS (P3-T07): the platform admin behind a support (impersonation) session; unset for a normal session. */
	impersonatedBy?: string | undefined;
};

interface ORPCContext {
	locale: Locale;
	reqHeaders: Headers;
	resHeaders?: Headers;
	trustedClient?: string;
	/** Set only by a server adapter after authenticating this request. */
	authentication?: RequestAuthentication | null;
	/** CAREEROS (P2-T03): the request's resolved host. Set by the server adapters; absent means the platform host. */
	host?: HostContext;
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
export async function resolveAuthenticationFromRequestHeaders(
	headers: Headers,
	// CAREEROS (P2-T03): an organization host also trusts its own origin; falls back to the host the server adapter registered.
	host: HostContext | undefined = currentHost(),
): Promise<RequestAuthentication | null> {
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
		((origin && !TRUSTED_ORIGINS.includes(origin) && !(host?.kind === "org" && origin === host.origin)) ||
			headers.get("sec-fetch-site") === "cross-site")
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "This request came from another site. Open the app directly and try again.",
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
		// CAREEROS (P3-T07): a session impersonated by an admin is accepted only while its support record is live (60 minutes, not ended).
		const sessionRow = (result as { session?: { id?: string; impersonatedBy?: string | null } }).session;
		const impersonatedBy = sessionRow?.impersonatedBy ?? undefined;
		if (
			activeUser &&
			impersonatedBy &&
			!(await isImpersonationActive(sessionRow?.id ?? "", activeUser.id, impersonatedBy))
		)
			return null;
		return activeUser
			? {
					user: activeUser,
					method: "session",
					permissions: fullPermissions,
					sessionId: sessionRow?.id,
					impersonatedBy,
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
				? await resolveAuthenticationFromRequestHeaders(context.reqHeaders, context.host ?? currentHost())
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
	.use(({ context, procedure, path, next }) => {
		if (!context.user) throw new ORPCError("UNAUTHORIZED");
		// CAREEROS (P3-T07): a support session may not change the member's sign-in, credentials or billing, or use the console.
		if (context.authentication?.impersonatedBy && isRefusedWhileImpersonating(path.join(".")))
			throw new ORPCError("FORBIDDEN", {
				message: "This is not available during a support session.",
				data: { code: "IMPERSONATION_NOT_ALLOWED" },
			});
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

/** CAREEROS (P2-T03): maps a host-rule refusal to FORBIDDEN with a stable `data.code` the clients act on. */
export function toHostError(error: unknown): unknown {
	if (!(error instanceof TenancyError)) return error;
	if (error.code === "not_member_of_host_org")
		return new ORPCError("FORBIDDEN", {
			message: "You are not a member of this organization.",
			data: { code: "ORG_HOST_NOT_MEMBER" },
		});
	if (error.code === "key_org_mismatch")
		return new ORPCError("FORBIDDEN", {
			message: "This API key belongs to another organization.",
			data: { code: "ORG_HOST_KEY_MISMATCH" },
		});
	if (error.code === "unknown_org_host")
		return new ORPCError("NOT_FOUND", { message: "No organization answers on this address." });
	return error;
}

// CAREEROS: resolves the organization and runs the handler inside withOrgContext (P1-T02)
export const protectedProcedure = protectedProcedureWithoutOrg
	.use(async ({ context, next }) => {
		// CAREEROS (P2-T03): the host decides the organization on organization hosts; headers, query and body never do.
		const organizationId = context.authentication
			? await resolveOrgForAuthentication(context.authentication, context.host ?? currentHost()).catch(
					(error: unknown) => {
						throw toHostError(error);
					},
				)
			: undefined;
		const nextContext = { ...context, organizationId: organizationId as string | undefined };
		if (!organizationId) {
			// CAREEROS: enforcement is on since P1-T04 (see ORG_CONTEXT_REQUIRED). The branch below stays for the constant's `false` state.
			if (ORG_CONTEXT_REQUIRED) throw new ORPCError("FORBIDDEN", { message: "No active organization" });
			return next({ context: nextContext });
		}
		// CAREEROS (P3-T02, Q197): entitlements are read once per request and shared by every gate below.
		return runWithEntitlementsCache(() =>
			withOrgContext(organizationId, () => Promise.resolve(next({ context: nextContext }))),
		);
	})
	// CAREEROS (P3-T02): after the organization is resolved, a suspended organization may not write (phase plan D3).
	.use(enforceOrganizationStatus);
