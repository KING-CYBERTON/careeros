import { requireOrgId } from "@careeros/tenancy";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { generateId } from "@reactive-resume/utils/string";
import { BillingError } from "./errors";

// CAREEROS (P3-T01, phase plan D7): writing an organization's audit trail. The row is inserted through the app role, so
// row-level security applies: it can only be for the current organization, and the app role can never change or
// delete it afterwards. Platform-level rows (no organization) are written only by the definer function
// `careeros_audit_platform`.

const ACTION_PATTERN = /^[a-z][a-z0-9_.]{1,63}$/;

export type AuditContext = {
	/** The user who acted; null for the system (a scheduled job, a verified provider event). */
	actorUserId: string | null;
	/** Set while a platform admin acts as the actor (impersonation). */
	impersonatorUserId?: string | null;
	ip?: string | null;
};

export type AuditTarget = { type: string; id: string } | null;

/**
 * Adds one row to the audit log of the current organization (the one of the active `withOrgContext` scope: the
 * organization is never a parameter). `action` is a dotted lowercase name such as `member.removed`. `metadata` must
 * be JSON and must not hold secrets, tokens or personal data beyond ids.
 */
export async function audit(
	ctx: AuditContext,
	action: string,
	target: AuditTarget = null,
	metadata: Record<string, unknown> = {},
): Promise<string> {
	if (!ACTION_PATTERN.test(action))
		throw new BillingError("invalid_audit_action", `Audit action "${action}" must match ${ACTION_PATTERN.source}.`);
	const id = generateId();
	await db.insert(schema.auditLog).values({
		id,
		organizationId: requireOrgId(),
		actorUserId: ctx.actorUserId,
		impersonatorUserId: ctx.impersonatorUserId ?? null,
		action,
		targetType: target?.type ?? null,
		targetId: target?.id ?? null,
		metadata,
		ip: ctx.ip ?? null,
	});
	return id;
}
