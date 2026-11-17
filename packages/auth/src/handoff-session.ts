import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";

// CAREEROS (P2-T05, phase plan D5): the two session operations of the sign-in handoff, run inside Better Auth's own
// endpoint context so they use its session store and cookie helpers (`internalAdapter.createSession`,
// `setSessionCookie`, `deleteSessionCookie`) and never a hand-built cookie.
//
// Both endpoints are registered WITHOUT a path, like the organization plugin's `addMember`: Better Auth does not route
// them, so they answer 404 over HTTP and can only be called from server code as `auth.api.*`. Their callers
// (apps/server/src/http/handoff.ts) have already proved the one-time token, the browser and the host. Neither takes a
// cookie, a header or any other client input as the identity: the user id comes from the redeemed handoff row.

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new APIError("BAD_REQUEST", { message: `${name} is required.` });
	return value;
}

export const handoffSession = {
	id: "careeros-handoff-session",
	endpoints: {
		/**
		 * A fresh session for `userId` with `organizationId` active, and the session cookie for the host that is
		 * answering. A new session id and token every time, so nothing the browser already holds is reused.
		 */
		careerosHandoffCreateSession: createAuthEndpoint(
			// `$Infer` only types `auth.api` callers; the handler still checks what it gets.
			{ method: "POST", metadata: { $Infer: { body: {} as { userId: string; organizationId: string } } } },
			async (ctx) => {
				const body = (ctx.body ?? {}) as { userId?: unknown; organizationId?: unknown };
				const userId = requireString(body.userId, "userId");
				const organizationId = requireString(body.organizationId, "organizationId");
				const user = await ctx.context.internalAdapter.findUserById(userId);
				if (!user) throw new APIError("BAD_REQUEST", { message: "The account is unavailable." });
				const session = await ctx.context.internalAdapter.createSession(userId, false, {
					activeOrganizationId: organizationId,
				});
				if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "The session could not be created." });
				await setSessionCookie(ctx, { session, user });
				return ctx.json({ ok: true });
			},
		),

		/** Ends the session with this token and expires the session cookie in the reply. */
		careerosHandoffEndSession: createAuthEndpoint(
			{ method: "POST", metadata: { $Infer: { body: {} as { token: string } } } },
			async (ctx) => {
				const body = (ctx.body ?? {}) as { token?: unknown };
				await ctx.context.internalAdapter.deleteSession(requireString(body.token, "token"));
				deleteSessionCookie(ctx);
				return ctx.json({ ok: true });
			},
		),
	},
} satisfies BetterAuthPlugin;
