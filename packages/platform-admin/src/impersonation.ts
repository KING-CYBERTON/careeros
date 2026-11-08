import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { asDate } from "./dates";
import { guarded } from "./errors";

// CAREEROS (P3-T07, requirement 3, phase plan D6): the database half of impersonation. A platform admin starts a
// support session on the platform host (`startImpersonation` returns a one-time token), the token is redeemed on the
// member's organization host (`redeemImpersonation`), the session that creates is attached to the record, and every
// request of that session asks `isImpersonationActive`. Ending, by the member's "End now" or by the sweep, is audited in
// the member's organization and in the platform log. The 60-minute limit is fixed at the start in the database.

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export const isImpersonationToken = (value: unknown): value is string =>
	typeof value === "string" && TOKEN_SHAPE.test(value);

export type StartImpersonationInput = {
	targetUserId: string;
	organizationId: string;
	reason: string;
	/** The browser origin of the member's organization host, as the host resolver reports it. */
	targetOrigin: string;
};

export type StartedImpersonation = {
	id: string;
	/** The one-time token; only its hash is stored. Never log it. */
	token: string;
	expiresAt: Date;
	tokenExpiresAt: Date;
};

/** Starts a support session: checks the actor and the target in the database, audits twice, returns the token. */
export function startImpersonation(actorUserId: string, input: StartImpersonationInput): Promise<StartedImpersonation> {
	const token = randomBytes(32).toString("base64url");
	return guarded(async () => {
		const { rows } = await db.execute<{
			out_id: string;
			out_expires_at: Date | string;
			out_token_expires_at: Date | string;
		}>(
			sql`select * from careeros_admin_impersonation_start(${actorUserId}::text, ${input.targetUserId}::text, ${input.organizationId}::text, ${input.reason}::text, ${input.targetOrigin}::text, ${sha256(token)}::text)`,
		);
		const row = rows[0];
		if (!row) throw new Error("The impersonation could not be started.");
		return {
			id: row.out_id,
			token,
			expiresAt: asDate(row.out_expires_at),
			tokenExpiresAt: asDate(row.out_token_expires_at),
		};
	});
}

export type RedeemedImpersonation = {
	targetUserId: string;
	organizationId: string;
	impersonatorUserId: string;
	expiresAt: Date;
};

/**
 * The redeem step on the member's organization host. One statement in the database checks the token, its expiry, the
 * origin and the organization of the host; `null` for every failure, with no detail.
 */
export async function redeemImpersonation(input: {
	id: unknown;
	token: unknown;
	targetOrigin: string;
	organizationId: string;
}): Promise<RedeemedImpersonation | null> {
	if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.id) || !isImpersonationToken(input.token))
		return null;
	const { rows } = await db.execute<{
		out_target_user_id: string;
		out_organization_id: string;
		out_impersonator_user_id: string;
		out_expires_at: Date | string;
	}>(
		sql`select * from careeros_impersonation_redeem(${input.id}::text, ${sha256(input.token)}::text, ${input.targetOrigin}::text, ${input.organizationId}::text)`,
	);
	const row = rows[0];
	return row
		? {
				targetUserId: row.out_target_user_id,
				organizationId: row.out_organization_id,
				impersonatorUserId: row.out_impersonator_user_id,
				expiresAt: asDate(row.out_expires_at),
			}
		: null;
}

/** Records the Better Auth session the redeem step created. */
export async function attachImpersonationSession(
	impersonationId: string,
	sessionId: string,
	targetUserId: string,
): Promise<boolean> {
	const { rows } = await db.execute<{ attached: boolean }>(
		sql`select careeros_impersonation_attach_session(${impersonationId}::text, ${sessionId}::text, ${targetUserId}::text) as attached`,
	);
	return rows[0]?.attached === true;
}

/** Whether this session is a live support session. A session impersonated by an admin without such a record is refused. */
export async function isImpersonationActive(
	sessionId: string,
	userId: string,
	impersonatorUserId: string,
): Promise<boolean> {
	const { rows } = await db.execute<{ active: boolean }>(
		sql`select careeros_impersonation_active(${sessionId}::text, ${userId}::text, ${impersonatorUserId}::text) as active`,
	);
	return rows[0]?.active === true;
}

export type ImpersonationBanner = {
	id: string;
	organizationId: string;
	organizationName: string | null;
	userName: string;
	expiresAt: Date;
};

/** What the banner shows, for the member's own session; null when it is not a live support session. */
export async function getImpersonationForSession(
	sessionId: string,
	userId: string,
): Promise<ImpersonationBanner | null> {
	const { rows } = await db.execute<{
		out_id: string;
		out_organization_id: string;
		out_organization_name: string | null;
		out_user_name: string;
		out_expires_at: Date | string;
	}>(sql`select * from careeros_impersonation_for_session(${sessionId}::text, ${userId}::text)`);
	const row = rows[0];
	return row
		? {
				id: row.out_id,
				organizationId: row.out_organization_id,
				organizationName: row.out_organization_name,
				userName: row.out_user_name,
				expiresAt: asDate(row.out_expires_at),
			}
		: null;
}

/** Ends this session's support session (the member's "End now"). False when there was none. */
export async function endImpersonation(sessionId: string, userId: string): Promise<boolean> {
	const { rows } = await db.execute<{ ended: boolean }>(
		sql`select careeros_impersonation_end(${sessionId}::text, ${userId}::text) as ended`,
	);
	return rows[0]?.ended === true;
}

/** The scheduled sweep: ends every support session that ran out, with its audit rows. Returns how many. */
export async function expireDueImpersonations(): Promise<number> {
	const { rows } = await db.execute<{ ended: number }>(sql`select careeros_impersonation_expire_due() as ended`);
	return Number(rows[0]?.ended ?? 0);
}
