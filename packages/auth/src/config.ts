import type { BetterAuthPlugin, User } from "better-auth";
import type {
	AnonymousOptions,
	GenericOAuthConfig,
	GenericOAuthUserInfo,
	UserWithAnonymous,
} from "better-auth/plugins";
import type { JWTPayload } from "jose";
import { AsyncLocalStorage } from "node:async_hooks";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { dash } from "@better-auth/infra";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { hostTrustedOrigins } from "@careeros/tenancy";
import { compare, hash } from "bcryptjs";
import { APIError, betterAuth } from "better-auth";
import {
	addOAuthServerContext,
	createAuthMiddleware,
	getOAuthState,
	getSessionFromCtx,
	isAPIError,
} from "better-auth/api";
import { deleteSessionCookie, parseSetCookieHeader, setSessionCookie } from "better-auth/cookies";
import { admin, anonymous, jwt, openAPI, organization } from "better-auth/plugins";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { twoFactor } from "better-auth/plugins/two-factor";
import { username } from "better-auth/plugins/username";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import { createElement } from "react";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { resetPasswordSubject, verifyEmailChangeSubject, verifyEmailSubject } from "@reactive-resume/email/subjects";
import { ResetPasswordEmail, VerifyEmail, VerifyEmailChange } from "@reactive-resume/email/templates/auth";
import { sendEmail } from "@reactive-resume/email/transport";
import { env } from "@reactive-resume/env/server";
import { PLATFORM_DEFAULT_APP_NAME } from "@reactive-resume/utils/brand";
import { rateLimitConfig } from "@reactive-resume/utils/rate-limit";
import { generateId, toUsername } from "@reactive-resume/utils/string";
import { timezoneSchema } from "@reactive-resume/utils/timezone";
import { isAllowedOAuthRedirectUri } from "@reactive-resume/utils/url-security.node";
// CAREEROS: Job Clipper sign-in, device flow and host-bound tokens (P5-T02)
import { clipperDeviceAuthorization, clipperTokens } from "./clipper";
// CAREEROS: branded emails (P2-T04)
import { buildEmailContext, withLinkOrigin } from "./email-brand";
// CAREEROS: the session operations of the sign-in handoff (P2-T05)
import { handoffSession } from "./handoff-session";
import { createGithubProfileMapper, createProfileMapper, isUsernameReserved } from "./oauth-profile";
// CAREEROS: invite-only organization hosts (P2-T03)
import { guardOrgHostSignUp } from "./org-host";
// CAREEROS: organization plugin options (P1-T01)
import { organizationOptions } from "./organization";
import { withSeatLimitErrorsFactory } from "./organization-enforcement";
// CAREEROS: personal organization at signup, default active organization, owner-only role changes (P1-T03)
import { organizationRules } from "./organization-rules";
import {
	createPersonalOrganization,
	deleteSoleMemberOrganizations,
	withDefaultActiveOrganization,
} from "./personal-org";
import { authRateLimitStorage } from "./rate-limit";
import { getTrustedOrigins } from "./trusted-origins";

const authBaseUrl = env.APP_URL;
const isRateLimitEnabled = process.env.NODE_ENV === "production" && !env.FLAG_DISABLE_API_RATE_LIMIT;

const oauthAudienceBase = authBaseUrl.replace(/\/$/, "");
// These identify the same account-wide API/MCP resource, not separate permission
// tiers. Protected-resource metadata advertises the root; MCP clients may also
// select the mounted endpoint or normalize either URI with a trailing slash.
const OAUTH_AUDIENCES = [
	oauthAudienceBase,
	`${oauthAudienceBase}/`,
	`${oauthAudienceBase}/mcp`,
	`${oauthAudienceBase}/mcp/`,
];

export async function verifyOAuthToken(token: string): Promise<JWTPayload> {
	// Use the same in-process verification on Docker and Vercel. Access tokens must
	// identify a live client/grant and cannot use proof binding without a DPoP proof.
	const { payload } = await jwtVerify(token, createLocalJWKSet(await auth.api.getJwks()), {
		issuer: `${authBaseUrl}/api/auth`,
		audience: OAUTH_AUDIENCES,
		requiredClaims: ["sub", "exp", "iat", "azp"],
	});
	if (payload.cnf || typeof payload.sub !== "string" || typeof payload.azp !== "string") {
		throw new APIError("UNAUTHORIZED", { message: "Invalid bearer token." });
	}
	const [client] = await db
		.select()
		.from(schema.oauthClient)
		.where(eq(schema.oauthClient.clientId, payload.azp))
		.limit(1);
	if (!client || client.disabled)
		throw new APIError("UNAUTHORIZED", { message: "OAuth client is disabled or deleted." });
	const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
	// offline_access grants outlive the browser session. After refresh revocation or in-app sign-out,
	// issued JWT access tokens remain valid for up to 1 h; consent revocation blocks them immediately below.
	if (payload.sid !== undefined && !scopes.includes("offline_access")) {
		if (typeof payload.sid !== "string") throw new APIError("UNAUTHORIZED", { message: "Invalid token session." });
		const [session] = await db
			.select()
			.from(schema.session)
			.where(
				and(
					eq(schema.session.id, payload.sid),
					eq(schema.session.userId, payload.sub),
					gt(schema.session.expiresAt, new Date()),
				),
			)
			.limit(1);
		if (!session) throw new APIError("UNAUTHORIZED", { message: "OAuth session has ended. Sign in again." });
	}
	const [consent] = await db
		.select()
		.from(schema.oauthConsent)
		.where(and(eq(schema.oauthConsent.clientId, payload.azp), eq(schema.oauthConsent.userId, payload.sub)))
		.limit(1);
	if (
		!consent ||
		(payload.rr_grant_id !== undefined
			? payload.rr_grant_id !== consent.id
			: consent.createdAt && Math.floor(consent.createdAt.getTime() / 1000) >= Number(payload.iat)) ||
		(!scopes.some((scope) => scope.startsWith("api:")) && consent.scopes.some((scope) => scope.startsWith("api:"))) ||
		scopes.some((scope) => !consent.scopes.includes(scope))
	) {
		throw new APIError("UNAUTHORIZED", { message: "OAuth access has been revoked. Reconnect the application." });
	}
	return payload;
}

export function isCustomOAuthProviderEnabled() {
	const hasDiscovery = Boolean(env.OAUTH_DISCOVERY_URL);
	const hasManual =
		Boolean(env.OAUTH_AUTHORIZATION_URL) && Boolean(env.OAUTH_TOKEN_URL) && Boolean(env.OAUTH_USER_INFO_URL);

	return Boolean(env.OAUTH_CLIENT_ID) && Boolean(env.OAUTH_CLIENT_SECRET) && (hasDiscovery || hasManual);
}

const TRUSTED_ORIGINS = getTrustedOrigins(env.APP_URL);
const accountUser = new AsyncLocalStorage<User>();
const oauthProviderRateLimit = isRateLimitEnabled
	? rateLimitConfig.betterAuth.oauthProvider
	: ({
			register: false,
			authorize: false,
			token: false,
			introspect: false,
			revoke: false,
			userinfo: false,
		} as const);

// Better Auth 1.7 types generic-OAuth profile extras as `unknown`.
function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

// `@better-auth/oauth-provider@1.7.1` declares OpenAPI parameter metadata (`schema.items`) in a
// shape that is not `exactOptionalPropertyTypes`-clean, which stops the plugin from structurally
// satisfying `BetterAuthPlugin`. `metadata` only feeds doc generation, so dropping it from the
// endpoint types keeps request/response inference (`auth.api.*`) intact. Remove once upstream ships
// EOPT-compatible endpoint types.
type WithoutEndpointMetadata<TPlugin> = TPlugin extends { endpoints: infer TEndpoints }
	? Omit<TPlugin, "endpoints"> & {
			endpoints: {
				[K in keyof TEndpoints]: TEndpoints[K] extends {
					(...args: infer TArgs): infer TResult;
					options: infer TOptions;
					path: infer TPath;
				}
					? {
							(...args: TArgs): TResult;
							options: Omit<TOptions, "metadata">;
							path: TPath;
						}
					: TEndpoints[K];
			};
		}
	: TPlugin;

/** Prepare external resources before commit; optional cleanup runs only after commit. */
export type AccountLinkHook = (params: {
	fromUserId: string;
	toUserId: string;
	excludedStoragePrefixes: string[];
}) => Promise<(() => Promise<void>) | void>;

let accountLinkHook: AccountLinkHook | undefined;

/** Sets the one account-link hook; no argument clears it. */
export function setAccountLinkHook(hook?: AccountLinkHook): void {
	accountLinkHook = hook;
}

export async function linkAnonymousAccount({
	fromUserId,
	toUserId,
}: {
	fromUserId: string;
	toUserId: string;
}): Promise<void> {
	if (fromUserId === toUserId) return;

	const cleanup = await db.transaction(async (tx) => {
		// Match document/application writers' owner-first order; stable order prevents opposing-link deadlocks.
		for (const userId of [fromUserId, toUserId].sort()) {
			const [owner] = await tx
				.select({ id: schema.user.id })
				.from(schema.user)
				.where(eq(schema.user.id, userId))
				.for("no key update");
			if (!owner) throw new APIError("NOT_FOUND", { message: "The account is unavailable." });
		}

		// CAREEROS (P1-T04): resumes, their versions, slug redirects and statistics now belong to an organization, and
		// row-level security hides the guest's organization from this request. A narrow security definer function
		// moves them to the account's oldest organization (see migration 20261101004553_resumes_rls). It refuses a
		// source that is not a guest and a target organization the account is not a member of. The slug suffix,
		// the upload-path rewrite and the redirect de-duplication are the same as before, done inside the function.
		// Called without a schema so that tests with their own schema can install a local copy.
		const [targetMembership] = await tx
			.select({ organizationId: schema.member.organizationId })
			.from(schema.member)
			.where(eq(schema.member.userId, toUserId))
			.orderBy(asc(schema.member.createdAt), asc(schema.member.id))
			.limit(1);
		await tx.execute(
			sql`select careeros_move_guest_resumes(${fromUserId}, ${toUserId}, ${targetMembership?.organizationId ?? null})`,
		);

		// CAREEROS (P1-T05): cover letters and their versions belong to an organization too; the same narrow definer
		// function pattern moves them to the account's oldest organization (it refuses a non-guest source and a
		// target organization the account is not a member of). The upload-path rewrite happens inside the function.
		await tx.execute(
			sql`select careeros_move_guest_cover_letters(${fromUserId}, ${toUserId}, ${targetMembership?.organizationId ?? null})`,
		);

		// CAREEROS (P1-T06): the application profile, pipeline, lanes and applications belong to an organization too, and
		// are per (organization, user) (D11). The same narrow definer function pattern moves them into the account's
		// oldest organization: a profile on both sides, or a merged pipeline over 40 active lanes, is a conflict (the
		// function raises SQLSTATE CR001 and CR002); system lanes map to the target's, custom lanes are copied, and
		// stage history lane references and upload paths follow. The function is called as one statement.
		try {
			await tx.execute(
				sql`select careeros_move_guest_applications(${fromUserId}, ${toUserId}, ${targetMembership?.organizationId ?? null})`,
			);
		} catch (error) {
			const code = ((error as { code?: string; cause?: { code?: string } }).cause ?? (error as { code?: string })).code;
			if (code === "CR001")
				throw new APIError("CONFLICT", {
					message:
						"Both accounts have a private application profile. Export and delete one profile in Settings → Account before linking, so neither is silently overwritten.",
				});
			if (code === "CR002")
				throw new APIError("CONFLICT", {
					message:
						"Retire unused application lanes before combining these accounts; the combined pipeline exceeds 40 active lanes.",
				});
			throw error;
		}

		// CAREEROS (P1-T07): saved application answers, and the career rows that belong to the guest's applications (facts,
		// stories, saved items, transcripts, schedules and their jobs, notifications, workspaces, tracked roles), belong
		// to an organization too. The same narrow definer function pattern moves them into the account's oldest
		// organization, after the applications they follow. The same saved answer on both sides is a conflict (SQLSTATE
		// CR004) so neither is silently overwritten. Knowledge not tied to an application stays with the guest, as before.
		try {
			await tx.execute(
				sql`select careeros_move_guest_career(${fromUserId}, ${toUserId}, ${targetMembership?.organizationId ?? null})`,
			);
		} catch (error) {
			const code = ((error as { code?: string; cause?: { code?: string } }).cause ?? (error as { code?: string })).code;
			if (code === "CR004")
				throw new APIError("CONFLICT", {
					message:
						"Both accounts have duplicate saved application answers. Export and delete one copy before linking, so neither is silently overwritten.",
				});
			throw error;
		}

		// CAREEROS (P4-T02, Q226): job discovery automations, their runs and the jobs they found belong to an
		// organization too. The same narrow definer function pattern moves them into the account's oldest organization,
		// after the applications the accepted jobs point at. At most 20 automations fit per user and organization; a job
		// the target already has keeps the target's row (and its dismissed or accepted status).
		await tx.execute(
			sql`select careeros_move_guest_discovery(${fromUserId}, ${toUserId}, ${targetMembership?.organizationId ?? null})`,
		);

		// CAREEROS (P1-T08): saved AI connections, assistant conversations (with their messages, attachments and actions) and
		// content reports belong to an organization too. The same narrow definer function pattern moves them into the
		// account's oldest organization, after the documents and applications they point at. The guest's default
		// connection yields to the target's, and the server-managed connection is re-pointed to the target's own.
		await tx.execute(
			sql`select careeros_move_guest_agent(${fromUserId}, ${toUserId}, ${targetMembership?.organizationId ?? null})`,
		);

		// Ownership updates lock document rows, so guest saves cannot add uncopied references during copying.
		const hook = accountLinkHook;
		if (!hook) return;
		// CAREEROS (P1-T09): the guest's erasure work sits in the guest's organizations, which row-level security hides
		// from this request. A definer function returns the storage keys of an anonymous user's jobs. A guest's custom
		// domain and web connection are deliberately not moved (see docs/plans/P1-T09-remaining-rls.md): they are
		// proven by DNS or hold the guest's own key, and they go away with the guest account as before.
		const { rows: erasures } = await tx.execute<{ storageKey: string }>(
			sql`select careeros_guest_cleanup_prefixes(${fromUserId}) as "storageKey"`,
		);
		return hook({ fromUserId, toUserId, excludedStoragePrefixes: erasures.map(({ storageKey }) => storageKey) });
	});

	try {
		await cleanup?.();
	} catch (error) {
		console.warn("Failed to clean up linked account resources:", error);
	}
}

type GuestLink = Parameters<NonNullable<AnonymousOptions["onLinkAccount"]>>[0];

async function moveGuestWork({ anonymousUser, newUser, ctx }: GuestLink): Promise<void> {
	try {
		await linkAnonymousAccount({
			fromUserId: anonymousUser.user.id,
			toUserId: newUser.user.id,
		});
	} catch (error) {
		// Better Auth sets the new session cookie before this runs. A failed transfer must leave the
		// guest accessible, and must not expose a usable credential-session cookie on the error reply.
		deleteSessionCookie(ctx);
		await setSessionCookie(ctx, anonymousUser, undefined, {
			maxAge: Math.max(0, Math.floor((anonymousUser.session.expiresAt.getTime() - Date.now()) / 1000)),
		});
		await ctx.context.internalAdapter.deleteSession(newUser.session.token).catch(() => {});
		if (isAPIError(error)) throw error;
		// Better Auth keeps these cookies only on an APIError reply; any other error drops them.
		console.error("Failed to move guest work to account %s:", newUser.user.id, error);
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: "The guest work could not be moved to this account. Try again.",
		});
	}
}

// Better Auth 1.7 keeps this name internal to its two-factor plugin.
const TWO_FACTOR_COOKIE = "two_factor";
const guestLinkIdentifier = (userId: string, challenge: string) => `guest-link:${userId}:${challenge}`;
const isTwoFactorVerification = (path: string | undefined) =>
	path === "/two-factor/verify-totp" || path === "/two-factor/verify-backup-code" || path === "/two-factor/verify-otp";

/** Read before a verification request runs; it carries the guest through to that request's after-hook. */
type GuestHandoff = { userId: string; challengeId: string; guestId: string };

// The anonymous plugin moves guest work only when a sign-in reply sets a session. With two-step verification,
// the password step sets none and the verification step is outside the plugin's matcher. This plugin stores the
// guest's id server-side, keyed by the account and the signed, single-use two-factor challenge, and moves the
// work when that challenge succeeds for that account.
const twoFactorGuestLink = {
	id: "two-factor-guest-link",
	hooks: {
		before: [
			{
				matcher: (ctx) => isTwoFactorVerification(ctx.path),
				handler: createAuthMiddleware(async (ctx) => {
					// Read the handoff before the endpoint accepts the challenge. Both expire together, so a challenge the
					// endpoint accepts had a live handoff here, even if the deadline passes while its session is created.
					const challengeId = await ctx.getSignedCookie(
						ctx.context.createAuthCookie(TWO_FACTOR_COOKIE).name,
						ctx.context.secret,
					);
					if (!challengeId) return;
					const internal = ctx.context.internalAdapter;
					// These lookups return expired rows too.
					const challenge = await internal.findVerificationValue(challengeId);
					if (!challenge || challenge.expiresAt <= new Date()) return;
					const link = await internal.findVerificationValue(guestLinkIdentifier(challenge.value, challengeId));
					if (!link || link.expiresAt <= new Date()) return;
					const guestHandoff: GuestHandoff = { userId: challenge.value, challengeId, guestId: link.value };
					return { context: { context: { guestHandoff } } };
				}),
			},
		],
		after: [
			{
				matcher: (ctx) => ctx.path === "/sign-in/email" || ctx.path === "/sign-in/username",
				handler: createAuthMiddleware(async (ctx) => {
					const cookieName = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE).name;
					// Our own reply's signed value: `<identifier>.<signature>`, URL-encoded.
					const signed = parseSetCookieHeader(ctx.context.responseHeaders?.get("set-cookie") ?? "").get(cookieName);
					const challengeId = signed && decodeURIComponent(signed.value).split(".")[0];
					if (!challengeId) return;
					const challenge = await ctx.context.internalAdapter.findVerificationValue(challengeId);
					if (!challenge) return;
					const guest = await getSessionFromCtx(ctx, { disableRefresh: true });
					if (!guest?.user.isAnonymous) return;
					await ctx.context.internalAdapter.createVerificationValue({
						identifier: guestLinkIdentifier(challenge.value, challengeId),
						value: guest.user.id,
						expiresAt: challenge.expiresAt,
					});
				}),
			},
			{
				matcher: (ctx) => isTwoFactorVerification(ctx.path),
				handler: createAuthMiddleware(async (ctx) => {
					const { guestHandoff: handoff } = ctx.context as { guestHandoff?: GuestHandoff };
					const newUser = ctx.context.newSession;
					if (!handoff || newUser?.user.id !== handoff.userId) return;
					const internal = ctx.context.internalAdapter;
					// The endpoint consumes the challenge, atomically, before it signs in. A challenge still stored means
					// this request did not accept it; one gone means this request was its only acceptance.
					if (await internal.findVerificationValue(handoff.challengeId)) return;
					// The anonymous plugin's schema adds this column; the adapter types only the core user.
					const user = (await internal.findUserById(handoff.guestId)) as UserWithAnonymous | null;
					if (!user?.isAnonymous) return;
					// Like the anonymous plugin, only a guest that can still sign in is linked, and kept on failure.
					const [session] = await internal.listSessions(user.id, { onlyActiveSessions: true });
					if (!session) return;
					try {
						await moveGuestWork({ anonymousUser: { user, session }, newUser, ctx });
						await internal.deleteUser(user.id).catch((error: unknown) => {
							ctx.context.logger.error("Failed to delete the linked guest account", { userId: user.id, error });
						});
					} finally {
						// The consumed challenge prevents replay; expiring bookkeeping must not undo a transfer or its recovery.
						await internal
							.deleteVerificationByIdentifier(guestLinkIdentifier(handoff.userId, handoff.challengeId))
							.catch(() => ctx.context.logger.warn("Failed to clean up completed guest-link marker"));
					}
				}),
			},
		],
	},
} satisfies BetterAuthPlugin;

const getAuthConfig = () => {
	const authConfigs: GenericOAuthConfig[] = [];

	if (isCustomOAuthProviderEnabled()) {
		authConfigs.push({
			providerId: "custom",
			disableSignUp: env.FLAG_DISABLE_SIGNUPS,
			clientId: env.OAUTH_CLIENT_ID as string,
			clientSecret: env.OAUTH_CLIENT_SECRET as string,
			discoveryUrl: env.OAUTH_DISCOVERY_URL,
			authorizationUrl: env.OAUTH_AUTHORIZATION_URL,
			tokenUrl: env.OAUTH_TOKEN_URL,
			userInfoUrl: env.OAUTH_USER_INFO_URL,
			scopes: env.OAUTH_SCOPES,
			// Better Auth 1.7 folds generic OAuth providers into `socialProviders`, so the callback
			// is served by `/callback/:id` — the old `/oauth2/callback/:id` route no longer exists.
			redirectURI: `${authBaseUrl}/api/auth/callback/custom`,
			mapProfileToUser: createProfileMapper<GenericOAuthUserInfo>({
				providerName: "OAuth Provider",
				getPreferredUsername: (profile, context) => asString(profile.preferred_username) ?? context.emailLocalPart,
				getName: (profile, context) =>
					asString(profile.name) ?? asString(profile.preferred_username) ?? context.emailLocalPart,
				getImage: (profile) => asString(profile.image) ?? asString(profile.picture) ?? asString(profile.avatar_url),
			}),
		} satisfies GenericOAuthConfig);
	}

	return betterAuth({
		appName: PLATFORM_DEFAULT_APP_NAME, // CAREEROS: P2-T08
		baseURL: authBaseUrl,
		secret: env.AUTH_SECRET,

		// CAREEROS (P3-T02): the seat-limit trigger's refusal becomes SEAT_LIMIT_REACHED, not a 500.
		database: withSeatLimitErrorsFactory(drizzleAdapter(db, { schema, provider: "pg" })),

		telemetry: { enabled: false },
		// CAREEROS (P2-T03, D5): Better Auth 1.7 accepts a function here, called with the request. The platform origins
		// stay; the request host's own origin is added only when it resolves to an organization host.
		trustedOrigins: async (request) => [
			...TRUSTED_ORIGINS,
			// Apple's form_post callback includes this origin; keep CSRF checks enabled.
			...(env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET ? ["https://appleid.apple.com"] : []),
			...(await hostTrustedOrigins(request)),
		],
		rateLimit: {
			...rateLimitConfig.betterAuth.global,
			...(authRateLimitStorage ? { customStorage: authRateLimitStorage } : {}),
			enabled: isRateLimitEnabled,
		},

		databaseHooks: {
			user: {
				create: {
					before: async (user, context) => {
						// CAREEROS (P2-T03, D6): an invite-only organization host refuses new accounts without an invitation
						await guardOrgHostSignUp(user, context);
						// New accounts inherit the device timezone from the auth request, so interview times,
						// reminders and schedules are right from the first use. Social callbacks don't carry the
						// header; the sign-in hook stores the validated zone in the signed OAuth state.
						const fromHeader = timezoneSchema.safeParse(context?.headers?.get("x-client-timezone"));
						// Direct calls outside an auth request have no OAuth state to read.
						const oauthState = context ? await getOAuthState().catch(() => null) : null;
						const fromOAuth = timezoneSchema.safeParse(oauthState?.serverContext?.timezone);
						const timezone = fromHeader.success ? fromHeader.data : fromOAuth.success ? fromOAuth.data : undefined;
						const data = timezone ? { ...user, timezone } : user;
						if (!user.isAnonymous) return timezone ? { data } : undefined;

						// Guests sign in without a username. The tail of a UUIDv7 is random; its head is a timestamp.
						const username = `guest-${generateId().slice(-12)}`;
						return { data: { ...data, username, displayUsername: username } };
					},
					// CAREEROS: every user gets a personal organization unless signing up through an invitation (P1-T03, D6)
					after: async (user, context) => {
						await createPersonalOrganization(user, context);
					},
				},
				// CAREEROS: a deleted user (a linked guest) takes the organizations only they belonged to with them (P1-T03)
				delete: {
					before: async (user) => {
						await deleteSoleMemberOrganizations(user.id);
					},
				},
			},
			session: {
				create: {
					// CAREEROS: a session without an active organization gets the user's oldest membership (P1-T03)
					before: (session) => withDefaultActiveOrganization(session),
				},
			},
		},

		// Unused endpoints: guest deletion skips the app's storage cleanup; the session JWT has no consumer.
		// CAREEROS (P5-T02): /device/token would issue a full session; the clipper redeems at /device/clipper/token instead.
		disabledPaths: ["/delete-anonymous-user", "/token", "/device/token"],

		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/sign-in/social") {
					const timezone = timezoneSchema.safeParse(ctx.headers?.get("x-client-timezone"));
					// Keep the device timezone across the provider redirect in server-only state, so the
					// callback can start a new account there without trusting redirect parameters.
					if (timezone.success) await addOAuthServerContext({ timezone: timezone.data });
				}

				const user = accountUser.getStore();
				// Sign-up copies displayUsername into username when username is missing, so either one claims the name.
				const requestedUsername: unknown = ctx.body?.username ?? ctx.body?.displayUsername;
				if (
					typeof requestedUsername === "string" &&
					["/sign-up/email", "/update-user", "/is-username-available"].includes(ctx.path)
				) {
					const claimant =
						user?.id ??
						(ctx.path === "/update-user"
							? (await auth.api.getSession({ headers: ctx.headers ?? new Headers() }))?.user.id
							: undefined);
					if (await isUsernameReserved(toUsername(requestedUsername), claimant))
						throw new APIError("UNPROCESSABLE_ENTITY", {
							code: "USERNAME_IS_ALREADY_TAKEN",
							message: "This username is already taken. Choose another.",
						});
				}
				if (user && !ctx.request && ["/update-user", "/api-key/list", "/api-key/delete"].includes(ctx.path)) {
					// Internal account calls reuse session-only hooks without creating a browser credential.
					return {
						context: {
							context: {
								session: {
									user,
									session: {
										id: "",
										token: "",
										userId: user.id,
										createdAt: new Date(0),
										updatedAt: new Date(0),
										expiresAt: new Date(0),
									},
								},
							},
						},
					};
				}
				if (ctx.path === "/sign-in/anonymous" && (!env.FLAG_ENABLE_GUEST_LOGIN || env.FLAG_DISABLE_SIGNUPS)) {
					throw new APIError("FORBIDDEN", {
						message: "Guest access is turned off on this server. Create an account or sign in.",
					});
				}
				if (ctx.path === "/verify-email") {
					// A verification link signs in as its account, and the anonymous plugin would then move the
					// guest's documents into it, even when the link belongs to someone else.
					const current = await auth.api.getSession({ headers: ctx.headers ?? new Headers() });
					if (current?.user.isAnonymous) {
						throw new APIError("FORBIDDEN", {
							message: "Sign out of the guest session before verifying an email address.",
						});
					}
					return;
				}
				if (ctx.path === "/sign-in/username" && env.FLAG_DISABLE_EMAIL_AUTH)
					throw new APIError("FORBIDDEN", { message: "Password sign-in is turned off on this server." });
				// Internal issuance is gated by the application's session-only, recent-sign-in procedure.
				if (ctx.path === "/api-key/create" && !ctx.request) return;
				if (
					["/passkey/generate-register-options", "/passkey/verify-registration", "/api-key/create"].includes(ctx.path)
				) {
					// freshAge is 0 so old sessions can unlink providers; adding a passkey still needs a recent sign-in.
					const current = await auth.api.getSession({
						headers: ctx.headers ?? new Headers(),
						query: { disableCookieCache: true },
					});
					if (!current) throw new APIError("UNAUTHORIZED");
					if (ctx.path.startsWith("/passkey/") && !current.user.emailVerified)
						throw new APIError("FORBIDDEN", { message: "Verify your email address before adding a passkey." });
					const age = Date.now() - new Date(current.session.createdAt).getTime();
					if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) {
						throw new APIError("FORBIDDEN", { message: "For your security, sign in again to add a credential." });
					}
					return;
				}
				if (ctx.path === "/oauth2/delete-consent") {
					const origin = ctx.headers?.get("origin");
					if ((origin && !TRUSTED_ORIGINS.includes(origin)) || ctx.headers?.get("sec-fetch-site") === "cross-site") {
						throw new APIError("FORBIDDEN", { message: "Cross-origin consent changes are not allowed." });
					}
					const current = await auth.api.getSession({
						headers: ctx.headers ?? new Headers(),
						query: { disableCookieCache: true },
					});
					const id = ctx.body?.id;
					if (!current || typeof id !== "string") throw new APIError("UNAUTHORIZED");
					const [consent] = await db
						.select()
						.from(schema.oauthConsent)
						.where(and(eq(schema.oauthConsent.id, id), eq(schema.oauthConsent.userId, current.user.id)))
						.limit(1);
					if (!consent) throw new APIError("NOT_FOUND");
					// Native consent deletion alone leaves refresh tokens usable. Revoke
					// the grant's stored tokens before removing its consent.
					const revoked = new Date();
					await db
						.update(schema.oauthRefreshToken)
						.set({ revoked })
						.where(
							and(
								eq(schema.oauthRefreshToken.clientId, consent.clientId),
								eq(schema.oauthRefreshToken.userId, current.user.id),
							),
						);
					await db
						.update(schema.oauthAccessToken)
						.set({ revoked })
						.where(
							and(
								eq(schema.oauthAccessToken.clientId, consent.clientId),
								eq(schema.oauthAccessToken.userId, current.user.id),
							),
						);
					return;
				}
				if (!ctx.path.includes("/oauth2/register")) return;

				const body = ctx.body as { redirect_uris?: unknown } | undefined;
				const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];

				for (const uri of redirectUris) {
					if (typeof uri !== "string") {
						throw new APIError("BAD_REQUEST", { message: "redirect_uris entries must be strings" });
					}
					if (
						!isAllowedOAuthRedirectUri(uri, TRUSTED_ORIGINS, {
							allowUnsafe: env.FLAG_ALLOW_UNSAFE_OAUTH_REDIRECT_URI,
						})
					) {
						throw new APIError("BAD_REQUEST", {
							message: "redirect_uri is not allowed for dynamic client registration",
						});
					}
				}
			}),
		},

		// Without this, OAuth callback failures land on Better Auth's built-in `/api/auth/error`
		// page. It also backs the `oauthProvider` plugin's authorization errors that happen before
		// `redirect_uri` is validated and so cannot be returned to the requesting client.
		onAPIError: { errorURL: "/auth/error" },

		advanced: {
			database: { generateId, joins: true },
			useSecureCookies: authBaseUrl.startsWith("https://"),
			ipAddress: { ipAddressHeaders: ["X-Real-IP"] },
		},

		emailAndPassword: {
			enabled: !env.FLAG_DISABLE_EMAIL_AUTH,
			autoSignIn: true,
			minPasswordLength: 8,
			maxPasswordLength: 64,
			requireEmailVerification: false,
			disableSignUp: env.FLAG_DISABLE_SIGNUPS || env.FLAG_DISABLE_EMAIL_AUTH,
			// CAREEROS (P2-T04): branded by the request's host organization, and linked to that host (email-brand.ts).
			sendResetPassword: async ({ user, url }, request) => {
				const mail = await buildEmailContext({ source: "request", request });
				await sendEmail({
					to: user.email,
					subject: resetPasswordSubject(mail.brand),
					react: createElement(ResetPasswordEmail, { url: withLinkOrigin(url, mail.linkOrigin), brand: mail.brand }),
					fromName: mail.fromName,
					replyTo: mail.replyTo,
				});
			},
			revokeSessionsOnPasswordReset: true,
			// The reset link proved control of the inbox. Drop credentials someone else may hold, such as on an
			// account registered with this address before its owner.
			onPasswordReset: async ({ user }) => {
				await db.transaction(async (tx) => {
					await tx.delete(schema.apikey).where(eq(schema.apikey.referenceId, user.id));
					await tx.delete(schema.oauthAccessToken).where(eq(schema.oauthAccessToken.userId, user.id));
					await tx.delete(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.userId, user.id));
					await tx.delete(schema.oauthConsent).where(eq(schema.oauthConsent.userId, user.id));
					// CAREEROS (P5-T02): clipper sign-ins are credentials too.
					await tx.delete(schema.clipperToken).where(eq(schema.clipperToken.userId, user.id));
					// Historical passkeys may predate mailbox verification; recovery revokes all of them.
					await tx.delete(schema.passkey).where(eq(schema.passkey.userId, user.id));
					// Nobody had proved this address before: whoever signed up with it may have added other ways in.
					if (!user.emailVerified) {
						await tx.delete(schema.twoFactor).where(eq(schema.twoFactor.userId, user.id));
						await tx
							.delete(schema.account)
							.where(and(eq(schema.account.userId, user.id), ne(schema.account.providerId, "credential")));
					}
					await tx
						.update(schema.user)
						.set({ emailVerified: true, ...(user.emailVerified ? {} : { twoFactorEnabled: false }) })
						.where(eq(schema.user.id, user.id));
				});
			},
			password: {
				hash: (password) => hash(password, 10),
				verify: ({ password, hash }) => compare(password, hash),
			},
		},

		emailVerification: {
			sendOnSignUp: true,
			autoSignInAfterVerification: true,
			// CAREEROS (P2-T04): see sendResetPassword.
			sendVerificationEmail: async ({ user, url }, request) => {
				const mail = await buildEmailContext({ source: "request", request });
				await sendEmail({
					to: user.email,
					subject: verifyEmailSubject(mail.brand),
					react: createElement(VerifyEmail, { url: withLinkOrigin(url, mail.linkOrigin), brand: mail.brand }),
					fromName: mail.fromName,
					replyTo: mail.replyTo,
				});
			},
		},

		user: {
			changeEmail: {
				enabled: true,
				// Better Auth's two-step change: the current address approves first, then the new address gets its own
				// verification link. Sending this step to the new address would let anyone holding a session move the
				// account to an address they control without the owner's approval.
				// CAREEROS (P2-T04): see sendResetPassword.
				sendChangeEmailConfirmation: async ({ user, newEmail, url }, request) => {
					const mail = await buildEmailContext({ source: "request", request });
					await sendEmail({
						to: user.email,
						subject: verifyEmailChangeSubject(mail.brand),
						react: createElement(VerifyEmailChange, {
							url: withLinkOrigin(url, mail.linkOrigin),
							previousEmail: user.email,
							newEmail,
							brand: mail.brand,
						}),
						fromName: mail.fromName,
						replyTo: mail.replyTo,
					});
				},
			},
			additionalFields: {
				username: {
					type: "string",
					required: true,
				},
				timezone: {
					type: "string",
					required: false,
					defaultValue: "UTC",
					validator: { input: timezoneSchema },
				},
			},
		},

		// Better Auth gates `/unlink-account` (and `/list-sessions`) behind a "fresh"
		// session, which defaults to one day old. Sessions here live for a week and
		// there is no re-authentication flow to refresh that timestamp, so disconnecting
		// a provider failed with `SESSION_NOT_FRESH` for anyone who signed in yesterday.
		session: { freshAge: 0 },

		account: {
			// Linking by email needs the provider to report that email as verified.
			accountLinking: { enabled: true },
			encryptOAuthTokens: true,
		},

		socialProviders: {
			apple: {
				enabled: !!env.APPLE_CLIENT_ID && !!env.APPLE_CLIENT_SECRET,
				disableSignUp: env.FLAG_DISABLE_SIGNUPS,
				clientId: env.APPLE_CLIENT_ID ?? "",
				clientSecret: env.APPLE_CLIENT_SECRET ?? "",
				mapProfileToUser: createProfileMapper({
					providerName: "Apple",
					getName: (profile, context) => profile.name || context.emailLocalPart,
				}),
			},

			google: {
				enabled: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
				disableSignUp: env.FLAG_DISABLE_SIGNUPS,
				clientId: env.GOOGLE_CLIENT_ID ?? "",
				clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
				mapProfileToUser: createProfileMapper({
					providerName: "Google",
					getName: (profile, context) => profile.name ?? context.emailLocalPart,
					getImage: (profile) => profile.picture,
				}),
			},

			github: {
				enabled: !!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET,
				disableSignUp: env.FLAG_DISABLE_SIGNUPS,
				clientId: env.GITHUB_CLIENT_ID ?? "",
				clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
				mapProfileToUser: createGithubProfileMapper(),
			},

			linkedin: {
				enabled: !!env.LINKEDIN_CLIENT_ID && !!env.LINKEDIN_CLIENT_SECRET,
				disableSignUp: env.FLAG_DISABLE_SIGNUPS,
				clientId: env.LINKEDIN_CLIENT_ID ?? "",
				clientSecret: env.LINKEDIN_CLIENT_SECRET ?? "",
				mapProfileToUser: createProfileMapper({
					providerName: "LinkedIn",
					getName: (profile, context) => profile.name ?? context.emailLocalPart,
					getImage: (profile) => profile.picture,
				}),
			},
		},

		plugins: [
			// JSON schema only; no reference-page inline scripts need a CSP nonce.
			openAPI({ disableDefaultReference: true }),
			jwt({ disableSettingJwtHeader: true }),
			admin(),
			// CAREEROS: organizations, members, invitations and the session's active organization (P1-T01)
			organization(organizationOptions),
			// CAREEROS: owner-only role changes (P1-T03)
			organizationRules,
			// CAREEROS (P2-T05): server-only session endpoints for the social and OIDC handoff to an organization host
			handoffSession,
			// CAREEROS (P5-T02): Job Clipper device flow and tokens (packages/auth/src/clipper.ts)
			clipperDeviceAuthorization,
			clipperTokens,
			passkey(),
			genericOAuth({ config: authConfigs }),
			twoFactor({ issuer: PLATFORM_DEFAULT_APP_NAME }),
			apiKey({
				enableSessionForAPIKeys: false,
				rateLimit: {
					...rateLimitConfig.betterAuth.apiKey,
					enabled: isRateLimitEnabled,
				},
			}),
			oauthProvider({
				loginPage: "/api/auth/oauth",
				consentPage: "/auth/consent",
				scopes: ["openid", "profile", "email", "offline_access", "api:read", "api:write", "api:delete"],
				extensions: [
					{
						claims: {
							accessToken: async ({ user, client }) => {
								if (!user) return {};
								const [consent] = await db
									.select({ id: schema.oauthConsent.id })
									.from(schema.oauthConsent)
									.where(
										and(eq(schema.oauthConsent.clientId, client.clientId), eq(schema.oauthConsent.userId, user.id)),
									)
									.limit(1);
								return { rr_grant_id: consent?.id ?? null };
							},
						},
					},
				],
				resources: OAUTH_AUDIENCES,
				clientRegistrationDefaultResources: OAUTH_AUDIENCES,
				allowDynamicClientRegistration: true,
				// Required for MCP client onboarding (RFC 7591). Redirect URI validation
				// and explicit user consent protect access by dynamically registered clients.
				allowUnauthenticatedClientRegistration: true,
				rateLimit: oauthProviderRateLimit,
				silenceWarnings: { oauthAuthServerConfig: true },
			}) as WithoutEndpointMetadata<ReturnType<typeof oauthProvider>>,
			username({
				minUsernameLength: 3,
				maxUsernameLength: 64,
				usernameNormalization: (value) => toUsername(value),
				displayUsernameNormalization: (value) => toUsername(value),
				usernameValidator: (username) => /^[a-z0-9._-]+$/.test(username),
				validationOrder: { username: "post-normalization", displayUsername: "post-normalization" },
			}),
			// After twoFactor, whose sign-in hook creates the challenge this binds the guest to. Like the anonymous plugin,
			// after oauthProvider: an OAuth login must not continue with the guest session a failed move restores.
			twoFactorGuestLink,
			anonymous({
				emailDomainName: "reactive-resume.local",
				generateName: () => "Guest",
				// Signing up or in from a guest session moves the guest's documents to that account; the plugin then
				// deletes the guest account, along with anything not moved here (assistant threads, career data).
				onLinkAccount: moveGuestWork,
			}),
			...(env.BETTER_AUTH_API_KEY
				? [dash({ apiKey: env.BETTER_AUTH_API_KEY, activityTracking: { enabled: true } })]
				: []),
		],
	});
};

type Auth = ReturnType<typeof getAuthConfig>;

let authInstance: Auth | undefined;

function getAuthInstance(): Auth {
	if (authInstance) return authInstance;

	const instance = getAuthConfig();
	authInstance = instance;
	// A rejected Better Auth context cannot recover. Let the next request rebuild it.
	void instance.$context.catch(() => {
		if (authInstance === instance) authInstance = undefined;
	});
	return instance;
}

// Keep initialization inside a request or explicit deployment preparation, not module evaluation.
export const auth: Auth = new Proxy({} as Auth, {
	get(_target, property) {
		const instance = getAuthInstance();
		return Reflect.get(instance, property, instance);
	},
});

type ProfileUpdate = { name?: string; username?: string; image?: string | null; timezone?: string };

// Only these server calls can install the identity; their cookie headers never leave this module.
export const accountAuth = {
	updateProfile: (user: User, body: ProfileUpdate) =>
		accountUser.run(user, () =>
			auth.api.updateUser({
				body: { ...body, ...(body.username !== undefined ? { displayUsername: body.username } : {}) },
			}),
		),
	listApiKeys: (user: User) => accountUser.run(user, () => auth.api.listApiKeys({})),
	deleteApiKey: (user: User, keyId: string) => accountUser.run(user, () => auth.api.deleteApiKey({ body: { keyId } })),
};

export async function initializeAuth(): Promise<void> {
	await auth.$context;
}
