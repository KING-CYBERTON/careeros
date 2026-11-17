import type { BetterAuthPlugin } from "better-auth";
import { resolveHost } from "@careeros/tenancy";
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deviceAuthorization, redeemDeviceCode } from "better-auth/plugins/device-authorization";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import {
	CLIPPER_CLIENT_ID,
	CLIPPER_SCOPE,
	DEVICE_CODE_LIFETIME,
	DEVICE_POLL_INTERVAL,
	LAST_USED_GRANULARITY_MS,
	TOKEN_LIFETIME_MS,
	USER_CODE_LENGTH,
	deviceLabel,
	generateClipperToken,
	hashClipperToken,
	hostMatchesOrganization,
	nextClipperExpiry,
	normalizeUserCode,
} from "./clipper-core";
import { consumeAuthRateLimit } from "./rate-limit";

// CAREEROS (P5-T02, phase plan G6): the Job Clipper signs in with the OAuth 2.0 device authorization flow, using Better
// Auth's `device-authorization` plugin (1.7.12) for the device code, the user code, and the approve and deny steps.
//
// What the installed plugin does not do, and this file adds:
//  - its `/device/token` hands out a full browser session. That endpoint is switched off here (the grant refuses it and
//    config.ts lists it in `disabledPaths`); `/device/clipper/token` redeems the same device code through the plugin's
//    own `redeemDeviceCode` state machine (expiry, polling interval, one-time claim) and issues a clipper token instead.
//  - it knows no host. The grant records the organization and host the code was requested on, and before-hooks refuse
//    verify, approve and deny on any other host and for anyone who is not a member of that organization.
//
// The token itself is a row of `clipper_token`: only its SHA-256 is stored. The server-only endpoints below (registered
// without a path, so they answer 404 over HTTP like the handoff ones) are the only code that reads or writes that table.

type DeviceCodeRecord = {
	id: string;
	userId?: string | null;
	status: string;
	clientId?: string | null;
	organizationId?: string | null;
	requestHost?: string | null;
};

function oauthError(error: string, description: string, status: "BAD_REQUEST" | "FORBIDDEN" = "BAD_REQUEST") {
	return new APIError(status, { error, error_description: description });
}

const INVALID_CODE = "That code is not valid or has expired. Start again from the extension.";

async function isMember(organizationId: string, userId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: schema.member.id })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
		.limit(1);
	return row !== undefined;
}

/** The device-code row for a user code as the plugin finds it: the code as typed, then letters and digits only. */
async function findByUserCode(
	ctx: {
		context: {
			adapter: {
				findOne: <T>(input: { model: string; where: { field: string; value: string }[] }) => Promise<T | null>;
			};
		};
	},
	userCode: string,
) {
	const find = (value: string) =>
		ctx.context.adapter.findOne<DeviceCodeRecord>({
			model: "deviceCode",
			where: [{ field: "userCode", value }],
		});
	return (await find(userCode)) ?? (await find(normalizeUserCode(userCode)));
}

const grant = {
	requestSchemaFields: {},
	deviceCodeSchemaFields: {
		organizationId: { type: "string", required: true },
		requestHost: { type: "string", required: true },
	},
	authorizeRequest: async ({ ctx, request }) => {
		if (request.client_id !== CLIPPER_CLIENT_ID) throw oauthError("invalid_client", "Invalid client ID");
		// A client must not pre-bind a code to an account: the member who approves claims it.
		if (request.user_id) throw oauthError("invalid_request", "user_id is not accepted");
		if (request.scope !== undefined && request.scope !== CLIPPER_SCOPE)
			throw oauthError("invalid_scope", "Invalid scope");
		const host = ctx.request ? await resolveHost(ctx.request) : undefined;
		// The host decides the organization; nothing in the body or a header can. Platform-host sign-in is Q260.
		if (host?.kind !== "org") throw oauthError("unauthorized_client", "Sign in from your organization's own address.");
		// Expired codes the client never polled again would otherwise stay; clear the old ones as new ones arrive.
		await ctx.context.adapter
			.deleteMany({
				model: "deviceCode",
				where: [{ field: "expiresAt", operator: "lt", value: new Date(Date.now() - 60 * 60 * 1000) }],
			})
			.catch(() => 0);
		return {
			clientId: CLIPPER_CLIENT_ID,
			deviceCodeFields: { organizationId: host.organizationId, requestHost: host.hostname },
		};
	},
	assertSessionRedemption: () => {
		throw oauthError("invalid_grant", "This code can only be exchanged for a clipper token.");
	},
	getVerificationContext: (deviceCodeRecord) => ({ request_host: String(deviceCodeRecord.requestHost ?? "") }),
} satisfies NonNullable<Parameters<typeof deviceAuthorization>[0]>["grant"];

/** Better Auth's device authorization plugin, set up for the clipper. */
export const clipperDeviceAuthorization = deviceAuthorization({
	expiresIn: DEVICE_CODE_LIFETIME,
	interval: DEVICE_POLL_INTERVAL,
	userCodeLength: USER_CODE_LENGTH,
	validateClient: (clientId) => clientId === CLIPPER_CLIENT_ID,
	grant,
});

const DEVICE_PATHS = new Set(["/device", "/device/approve", "/device/deny"]);
/** Per device code and minute. A well-behaved extension polls every 5 seconds: 12 times. */
export const DEVICE_TOKEN_CODE_LIMIT = { window: 60, max: 30 } as const;

const bearerOf = (headers: Headers | undefined): string | undefined => {
	const value = headers?.get("authorization");
	return value?.startsWith("Bearer ") ? value.slice(7).trim() : undefined;
};

const tokenBody = z.object({
	grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
	device_code: z.string().min(1).max(512),
	client_id: z.string().max(200),
});

type TokenRow = {
	id: string;
	tokenHash: string;
	userId: string;
	organizationId: string;
	host: string;
	label: string;
	createdAt: Date;
	lastUsedAt: Date | null;
	expiresAt: Date;
};

export const clipperTokens = {
	id: "careeros-clipper",
	schema: {
		clipperToken: {
			fields: {
				tokenHash: { type: "string", required: true, unique: true },
				userId: { type: "string", required: true, references: { model: "user", field: "id", onDelete: "cascade" } },
				organizationId: { type: "string", required: true },
				host: { type: "string", required: true },
				label: { type: "string", required: true },
				createdAt: { type: "date", required: true },
				lastUsedAt: { type: "date", required: false },
				expiresAt: { type: "date", required: true },
			},
		},
	},
	hooks: {
		before: [
			{
				// Verify, approve and deny only on the host the code was requested on, and only for a member of its
				// organization. A code requested elsewhere answers like a code that does not exist.
				matcher: (ctx) => DEVICE_PATHS.has(ctx.path ?? ""),
				handler: createAuthMiddleware(async (ctx) => {
					if (!ctx.request) return;
					const query = ctx.query as { user_code?: unknown } | undefined;
					const body = ctx.body as { userCode?: unknown } | undefined;
					const userCode = ctx.path === "/device" ? query?.user_code : body?.userCode;
					if (typeof userCode !== "string") return;
					const record = await findByUserCode(ctx, userCode);
					if (!record) return;
					const host = await resolveHost(ctx.request);
					if (!record.organizationId || !hostMatchesOrganization(host, record.organizationId))
						throw oauthError("invalid_request", INVALID_CODE);
					const session = await getSessionFromCtx(ctx);
					if (session?.user.id && !(await isMember(record.organizationId, session.user.id)))
						throw oauthError("access_denied", "You are not a member of this organization.", "FORBIDDEN");
				}),
			},
		],
	},
	endpoints: {
		/** Exchanges an approved device code for a clipper token. Public: the device code is the credential. */
		clipperDeviceToken: createAuthEndpoint(
			"/device/clipper/token",
			{ method: "POST", body: tokenBody, metadata: { noStore: true } },
			async (ctx) => {
				const { device_code: deviceCode, client_id: clientId } = ctx.body;
				if (clientId !== CLIPPER_CLIENT_ID) throw oauthError("invalid_grant", "Invalid client ID");
				const limit = await consumeAuthRateLimit(
					`clipper-device-code:${hashClipperToken(deviceCode)}`,
					DEVICE_TOKEN_CODE_LIMIT,
				);
				if (!limit.allowed) throw oauthError("slow_down", "Polling too frequently. Wait and try again.");
				const host = ctx.request ? await resolveHost(ctx.request) : undefined;

				const { claimedDeviceCode, user } = await redeemDeviceCode({
					ctx,
					deviceCode,
					authorizeRedemption: (record) => {
						const row = record as unknown as DeviceCodeRecord;
						// Redeemed on another host than it was requested on, by another client: refused before any state moves.
						if (
							row.clientId !== CLIPPER_CLIENT_ID ||
							!row.organizationId ||
							!hostMatchesOrganization(host, row.organizationId)
						)
							throw oauthError("invalid_grant", INVALID_CODE);
						return { ownershipWhere: { field: "clientId", value: CLIPPER_CLIENT_ID }, context: undefined };
					},
					// After approval, before the one-time claim: the approver must still be a member and not suspended.
					prepareRedemption: async (record) => {
						const row = record as unknown as DeviceCodeRecord;
						if (!row.userId || !row.organizationId || !(await isMember(row.organizationId, row.userId)))
							throw oauthError("access_denied", "The account is no longer a member of this organization.", "FORBIDDEN");
					},
				});
				const record = claimedDeviceCode as unknown as DeviceCodeRecord;
				if ((user as { banned?: boolean | null }).banned)
					throw oauthError("access_denied", "This account is suspended.", "FORBIDDEN");
				if (!record.organizationId || !record.requestHost) throw oauthError("invalid_grant", INVALID_CODE);

				const token = generateClipperToken();
				const now = Date.now();
				await ctx.context.adapter.create({
					model: "clipperToken",
					data: {
						tokenHash: hashClipperToken(token),
						userId: user.id,
						organizationId: record.organizationId,
						host: record.requestHost,
						label: deviceLabel(ctx.headers?.get("user-agent")),
						createdAt: new Date(now),
						lastUsedAt: null,
						expiresAt: new Date(now + TOKEN_LIFETIME_MS),
					},
				});
				// Expired sign-ins go as new ones arrive.
				await ctx.context.adapter
					.deleteMany({ model: "clipperToken", where: [{ field: "expiresAt", operator: "lt", value: new Date(now) }] })
					.catch(() => 0);
				ctx.setHeader("Cache-Control", "no-store");
				ctx.setHeader("Pragma", "no-cache");
				return ctx.json({
					access_token: token,
					token_type: "Bearer",
					expires_in: Math.floor(TOKEN_LIFETIME_MS / 1000),
					scope: CLIPPER_SCOPE,
					user_name: user.name,
				});
			},
		),

		/** Sign out from the extension: the token revokes itself. Idempotent; an unknown token is not an error. */
		clipperRevokeSelf: createAuthEndpoint(
			"/device/clipper/revoke",
			{ method: "POST", metadata: { noStore: true } },
			async (ctx) => {
				const token = bearerOf(ctx.headers);
				if (token) {
					await ctx.context.adapter.deleteMany({
						model: "clipperToken",
						where: [{ field: "tokenHash", value: hashClipperToken(token) }],
					});
				}
				return ctx.json({ success: true });
			},
		),

		// Server-only below: no path, so Better Auth does not route them. Callers (packages/api) pass identities they
		// resolved themselves; nothing here reads a cookie or a header.

		/**
		 * The row for a token when it is valid on this organization's host, else null. A use extends a token that has
		 * 30 days or fewer left to 90 days from now, and records the time of use (at most once a minute).
		 */
		clipperVerifyToken: createAuthEndpoint(
			{ method: "POST", metadata: { $Infer: { body: {} as { token: string; organizationId: string } } } },
			async (ctx) => {
				const body = (ctx.body ?? {}) as { token?: unknown; organizationId?: unknown };
				if (typeof body.token !== "string" || typeof body.organizationId !== "string") return ctx.json(null);
				const row = (await ctx.context.adapter.findOne({
					model: "clipperToken",
					where: [{ field: "tokenHash", value: hashClipperToken(body.token) }],
				})) as TokenRow | null;
				if (!row || row.organizationId !== body.organizationId) return ctx.json(null);
				const now = Date.now();
				const expiry = nextClipperExpiry(now, new Date(row.expiresAt).getTime());
				if (expiry === null) {
					await ctx.context.adapter.deleteMany({ model: "clipperToken", where: [{ field: "id", value: row.id }] });
					return ctx.json(null);
				}
				const lastUsed = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
				if (expiry !== new Date(row.expiresAt).getTime() || now - lastUsed >= LAST_USED_GRANULARITY_MS) {
					await ctx.context.adapter.update({
						model: "clipperToken",
						where: [{ field: "id", value: row.id }],
						update: { lastUsedAt: new Date(now), expiresAt: new Date(expiry) },
					});
				}
				return ctx.json({
					id: row.id,
					userId: row.userId,
					organizationId: row.organizationId,
					host: row.host,
					expiresAt: new Date(expiry).toISOString(),
				});
			},
		),

		/** The member's own active clipper sign-ins, newest first, with the organization's name. */
		clipperListTokens: createAuthEndpoint(
			{ method: "POST", metadata: { $Infer: { body: {} as { userId: string } } } },
			async (ctx) => {
				const body = (ctx.body ?? {}) as { userId?: unknown };
				if (typeof body.userId !== "string" || body.userId === "") throw new APIError("BAD_REQUEST");
				const rows = (await ctx.context.adapter.findMany({
					model: "clipperToken",
					where: [{ field: "userId", value: body.userId }],
				})) as TokenRow[];
				const names = new Map<string, string>();
				for (const organizationId of new Set(rows.map((row) => row.organizationId))) {
					const [org] = await db
						.select({ name: schema.organization.name })
						.from(schema.organization)
						.where(eq(schema.organization.id, organizationId))
						.limit(1);
					if (org) names.set(organizationId, org.name);
				}
				const now = Date.now();
				return ctx.json(
					rows
						.filter((row) => new Date(row.expiresAt).getTime() > now)
						.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
						.map((row) => ({
							id: row.id,
							organizationId: row.organizationId,
							organizationName: names.get(row.organizationId) ?? "",
							host: row.host,
							label: row.label,
							createdAt: new Date(row.createdAt).toISOString(),
							lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
							expiresAt: new Date(row.expiresAt).toISOString(),
						})),
				);
			},
		),

		/** Revokes one of this member's own sign-ins. Another member's id changes nothing. */
		clipperRevokeToken: createAuthEndpoint(
			{ method: "POST", metadata: { $Infer: { body: {} as { userId: string; id: string } } } },
			async (ctx) => {
				const body = (ctx.body ?? {}) as { userId?: unknown; id?: unknown };
				if (typeof body.userId !== "string" || typeof body.id !== "string") throw new APIError("BAD_REQUEST");
				const removed = await ctx.context.adapter.deleteMany({
					model: "clipperToken",
					where: [
						{ field: "id", value: body.id },
						{ field: "userId", value: body.userId },
					],
				});
				return ctx.json({ revoked: removed > 0 });
			},
		),
	},
} satisfies BetterAuthPlugin;
