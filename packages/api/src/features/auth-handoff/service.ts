import type { HostContext } from "@careeros/tenancy";
import { createHash, randomBytes } from "node:crypto";
import { resolveHost } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { authService } from "../auth/service";
import { getHostStatus, joinHostOrganization } from "../organization-host/service";
import { sanitizeReturnTo } from "./return-to";

// CAREEROS (P2-T05, phase plan D5): social and OIDC sign-in on an organization host. The handoff row is the only
// state: `begin` writes it on the organization host, `issue` adds a one-time token on the platform host, and `redeem`
// consumes it on the organization host. Secrets are hashed (SHA-256) before they reach the database and are never
// logged; every expiry is the database clock. See docs/plans/P2-T05-auth-handoff.md.

type OrgHost = Extract<HostContext, { kind: "org" }>;

/** The cookie that holds the browser-binding verifier on the organization host. */
export const HANDOFF_COOKIE = "careeros_handoff";
export const HANDOFF_COOKIE_PATH = "/api/careeros/handoff";
export const HANDOFF_COOKIE_MAX_AGE_SECONDS = 600;
export const HANDOFF_REQUEST_MINUTES = 10;
export const HANDOFF_TOKEN_SECONDS = 60;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const randomToken = (bytes: number) => randomBytes(bytes).toString("base64url");
// The shape the generators above produce; anything else cannot match a row, so it is refused before the database.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export const isHandoffValue = (value: unknown): value is string => typeof value === "string" && TOKEN_SHAPE.test(value);

/** The providers a handoff can use: every enabled social provider and the generic OIDC one. Not password or passkey. */
export function handoffProviders(): string[] {
	return Object.keys(authService.providers.list()).filter((id) => id !== "credential" && id !== "passkey");
}

export type BeginHandoffInput = { host: OrgHost; provider: unknown; returnTo: unknown };

/**
 * Starts a handoff for the organization host. Returns the request id and the browser verifier (for the cookie), or
 * `null` when the provider is not an enabled social or OIDC provider. The target origin and the organization come
 * from the resolved host; the client supplies only the provider and the (validated) return path.
 */
export async function beginHandoff(input: BeginHandoffInput): Promise<{ id: string; verifier: string } | null> {
	const { host } = input;
	if (typeof input.provider !== "string" || !handoffProviders().includes(input.provider)) return null;
	const id = randomToken(24);
	const verifier = randomToken(32);
	await db.insert(schema.authHandoff).values({
		id,
		organizationId: host.organizationId,
		targetOrigin: host.origin,
		returnTo: sanitizeReturnTo(input.returnTo, host.origin),
		browserBindingHash: sha256(verifier),
		provider: input.provider,
		expiresAt: sql`now() + ${HANDOFF_REQUEST_MINUTES} * interval '1 minute'`,
	});
	return { id, verifier };
}

/** What the platform page needs to start the sign-in: only for a request that exists, has not expired or been issued. */
export async function getHandoffRequest(id: unknown): Promise<{ provider: string; organizationName: string } | null> {
	if (!isHandoffValue(id)) return null;
	const [row] = await db
		.select({ provider: schema.authHandoff.provider, organizationName: schema.organization.name })
		.from(schema.authHandoff)
		.innerJoin(schema.organization, eq(schema.organization.id, schema.authHandoff.organizationId))
		.where(
			and(
				eq(schema.authHandoff.id, id),
				sql`${schema.authHandoff.expiresAt} > now()`,
				isNull(schema.authHandoff.tokenHash),
			),
		)
		.limit(1);
	return row ?? null;
}

export type IssueHandoffInput = {
	requestId: unknown;
	userId: string;
	/** When the platform session in use was created, to tell a session this flow created from one the user had. */
	sessionCreatedAt: Date;
};

export type IssueHandoffResult =
	| { kind: "invalid" }
	/** The user may not enter the organization (not a member, and it is not open): no token. */
	| { kind: "denied"; targetOrigin: string; revokePlatformSession: boolean }
	| { kind: "issued"; token: string; requestId: string; targetOrigin: string; revokePlatformSession: boolean };

/** The organization host the request was made for, as it resolves now; `null` when it is gone or points elsewhere. */
async function resolveTargetHost(targetOrigin: string, organizationId: string): Promise<OrgHost | null> {
	try {
		const host = await resolveHost(new Request(targetOrigin));
		return host.kind === "org" && host.organizationId === organizationId && host.origin === targetOrigin ? host : null;
	} catch {
		return null;
	}
}

/** Whether the user may enter the organization: a member, or someone T03's rules let join now (open signup). */
async function mayEnter(userId: string, host: OrgHost): Promise<boolean> {
	const status = await getHostStatus(userId, host);
	if (status.isMember) return true;
	if (!status.openSignup) return false;
	try {
		await joinHostOrganization(userId, host);
		return true;
	} catch (error) {
		// A concurrent join won the race: the user is a member now.
		if (error instanceof ORPCError && error.code === "CONFLICT") return true;
		if (error instanceof ORPCError && error.code === "FORBIDDEN") return false;
		throw error;
	}
}

/**
 * The issue step, after the provider's callback. Locks the row, checks the user may enter, stores the SHA-256 of a new
 * 256-bit token with a 60-second expiry (database time) and returns the token. The row can be issued once.
 */
export function issueHandoff(input: IssueHandoffInput): Promise<IssueHandoffResult> {
	const { requestId } = input;
	if (!isHandoffValue(requestId)) return Promise.resolve({ kind: "invalid" });
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({
				organizationId: schema.authHandoff.organizationId,
				targetOrigin: schema.authHandoff.targetOrigin,
				createdAt: schema.authHandoff.createdAt,
			})
			.from(schema.authHandoff)
			.where(
				and(
					eq(schema.authHandoff.id, requestId),
					sql`${schema.authHandoff.expiresAt} > now()`,
					isNull(schema.authHandoff.tokenHash),
				),
			)
			.limit(1)
			.for("update");
		if (!row) return { kind: "invalid" } as const;
		// Only a session the flow itself created is the flow's to end; one the user already had stays.
		const revokePlatformSession = input.sessionCreatedAt.getTime() >= row.createdAt.getTime();

		const host = await resolveTargetHost(row.targetOrigin, row.organizationId);
		if (!host) return { kind: "invalid" } as const;
		if (!(await mayEnter(input.userId, host)))
			return { kind: "denied", targetOrigin: row.targetOrigin, revokePlatformSession } as const;

		const token = randomToken(32);
		await tx
			.update(schema.authHandoff)
			.set({
				tokenHash: sha256(token),
				tokenExpiresAt: sql`now() + ${HANDOFF_TOKEN_SECONDS} * interval '1 second'`,
				userId: input.userId,
			})
			.where(eq(schema.authHandoff.id, requestId));
		return { kind: "issued", token, requestId, targetOrigin: row.targetOrigin, revokePlatformSession } as const;
	});
}

export type RedeemHandoffInput = { host: OrgHost; requestId: unknown; token: unknown; verifier: unknown };

/**
 * The redeem step, in one statement: the token is live (database clock), unredeemed, and its hash, the browser's
 * verifier hash, the organization host and the organization all match the row. Zero rows is one answer, `null`, for
 * every reason. A row is redeemed at most once.
 */
export async function redeemHandoff(
	input: RedeemHandoffInput,
): Promise<{ userId: string; organizationId: string; returnTo: string } | null> {
	const { requestId, token, verifier } = input;
	if (!isHandoffValue(requestId) || !isHandoffValue(token) || !isHandoffValue(verifier)) return null;
	const [row] = await db
		.update(schema.authHandoff)
		.set({ redeemedAt: sql`now()` })
		.where(
			and(
				eq(schema.authHandoff.id, requestId),
				isNull(schema.authHandoff.redeemedAt),
				sql`${schema.authHandoff.tokenExpiresAt} > now()`,
				eq(schema.authHandoff.tokenHash, sha256(token)),
				eq(schema.authHandoff.browserBindingHash, sha256(verifier)),
				eq(schema.authHandoff.targetOrigin, input.host.origin),
				eq(schema.authHandoff.organizationId, input.host.organizationId),
			),
		)
		.returning({
			userId: schema.authHandoff.userId,
			organizationId: schema.authHandoff.organizationId,
			returnTo: schema.authHandoff.returnTo,
		});
	return row?.userId ? { userId: row.userId, organizationId: row.organizationId, returnTo: row.returnTo } : null;
}

/** Deletes handoffs that expired more than an hour ago (database time). Run by the scheduled cleanup. */
export async function purgeExpiredHandoffs(): Promise<number> {
	const removed = await db
		.delete(schema.authHandoff)
		.where(sql`${schema.authHandoff.expiresAt} < now() - interval '1 hour'`)
		.returning({ id: schema.authHandoff.id });
	return removed.length;
}
