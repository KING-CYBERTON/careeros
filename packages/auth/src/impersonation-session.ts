import type { BetterAuthPlugin } from "better-auth";
import { isImpersonationActive } from "@careeros/platform-admin";
import { isAuthPathRefusedWhileImpersonating } from "@careeros/platform-admin/policy";
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";

// CAREEROS (P3-T07, requirement 3): the Better Auth half of support (impersonation) sessions.
//
// 1. A before-hook refuses the account-security endpoints (password, email, two-factor, passkeys, API keys, linked
//    accounts, account deletion) while the session in the request is a support session (`impersonatedBy` is set).
// 2. One server-only endpoint creates the support session. Like the handoff endpoints it has no path, so it answers
//    404 over HTTP; its only caller (apps/server/src/http/impersonation.ts) has already redeemed the one-time token in
//    the database. The expiry is the record's, 60 minutes from the start, never extended.

export const impersonationSession = {
	id: "careeros-impersonation-session",
	hooks: {
		before: [
			{
				matcher: (ctx) => isAuthPathRefusedWhileImpersonating(ctx.path ?? ""),
				handler: createAuthMiddleware(async (ctx) => {
					const session = await getSessionFromCtx(ctx, { disableRefresh: true }).catch(() => null);
					if (session?.session && (session.session as { impersonatedBy?: string | null }).impersonatedBy)
						throw new APIError("FORBIDDEN", {
							code: "IMPERSONATION_NOT_ALLOWED",
							message: "This is not available during a support session.",
						});
				}),
			},
		],
		after: [
			{
				// CAREEROS (Q427): the web app learns it is signed in from /get-session. A support session whose record has
				// ended or expired (the record's clock, not the session row's) answers "no session" there too, and its cookie
				// is cleared, as every oRPC request already does.
				matcher: (ctx) => ctx.path === "/get-session",
				handler: createAuthMiddleware(async (ctx) => {
					const returned = ctx.context.returned as
						| { session?: { id?: string; impersonatedBy?: string | null }; user?: { id?: string } }
						| null
						| undefined;
					const impersonatedBy = returned?.session?.impersonatedBy;
					if (!impersonatedBy || !returned?.session?.id || !returned.user?.id) return;
					if (await isImpersonationActive(returned.session.id, returned.user.id, impersonatedBy)) return;
					deleteSessionCookie(ctx);
					return ctx.json(null);
				}),
			},
		],
	},
	endpoints: {
		careerosImpersonationCreateSession: createAuthEndpoint(
			{
				method: "POST",
				metadata: {
					$Infer: {
						body: {} as { userId: string; organizationId: string; impersonatorUserId: string; expiresAt: string },
					},
				},
			},
			async (ctx) => {
				const body = (ctx.body ?? {}) as Record<string, unknown>;
				const text = (name: string) => {
					const value = body[name];
					if (typeof value !== "string" || value.length === 0)
						throw new APIError("BAD_REQUEST", { message: `${name} is required.` });
					return value;
				};
				const userId = text("userId");
				const expiresAt = new Date(text("expiresAt"));
				if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
					throw new APIError("BAD_REQUEST", { message: "The support session has ended." });
				const user = await ctx.context.internalAdapter.findUserById(userId);
				if (!user) throw new APIError("BAD_REQUEST", { message: "The account is unavailable." });
				const session = await ctx.context.internalAdapter.createSession(userId, true, {
					activeOrganizationId: text("organizationId"),
					impersonatedBy: text("impersonatorUserId"),
					expiresAt,
				});
				if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "The session could not be created." });
				// `dontRememberMe`: a browser-session cookie, gone when the browser closes.
				await setSessionCookie(ctx, { session, user }, true);
				return ctx.json({ ok: true, sessionId: session.id, token: session.token });
			},
		),
	},
} satisfies BetterAuthPlugin;
