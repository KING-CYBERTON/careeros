import type { AuditListInput } from "./schemas";
import { getEntitlements } from "@careeros/billing";
import { requireOrgId } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { requireOrganizationAdmin } from "../branding/service";

// CAREEROS (P3-T01): read-only. Both functions run inside the request's organization scope, so row-level security
// confines them; the organization id is never taken from the client.

/** What the current organization is allowed right now. Any member can read it. */
export async function getOrganizationEntitlements() {
	const entitlements = await getEntitlements(requireOrgId());
	return {
		...entitlements,
		status: entitlements.status as "trial" | "active" | "past_due" | "suspended",
	};
}

const DEFAULT_PAGE = 50;
// Microsecond precision, because created_at has it and a millisecond cursor would skip or repeat rows.
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([A-Za-z0-9_-]{1,64})$/;

/** The audit log of the current organization, newest first. Owners and admins only. */
export async function listAuditLog(userId: string, input: AuditListInput) {
	const organizationId = await requireOrganizationAdmin(userId);
	const limit = input.limit ?? DEFAULT_PAGE;
	let after: { createdAt: string; id: string } | undefined;
	if (input.cursor !== undefined) {
		const match = CURSOR.exec(input.cursor);
		if (!match?.[1] || !match[2]) throw new ORPCError("BAD_REQUEST", { message: "The cursor is not valid." });
		after = { createdAt: match[1], id: match[2] };
	}
	const cursorTime = sql<string>`to_char(${schema.auditLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
	const rows = await db
		.select({
			id: schema.auditLog.id,
			action: schema.auditLog.action,
			actorUserId: schema.auditLog.actorUserId,
			impersonatorUserId: schema.auditLog.impersonatorUserId,
			targetType: schema.auditLog.targetType,
			targetId: schema.auditLog.targetId,
			metadata: schema.auditLog.metadata,
			createdAt: schema.auditLog.createdAt,
			cursorTime,
		})
		.from(schema.auditLog)
		.where(
			and(
				eq(schema.auditLog.organizationId, organizationId),
				after
					? sql`(${schema.auditLog.createdAt}, ${schema.auditLog.id}) < (${after.createdAt}::timestamptz, ${after.id})`
					: undefined,
			),
		)
		.orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map(({ cursorTime: _cursorTime, ...entry }) => entry),
		nextCursor: rows.length > limit && last ? `${last.cursorTime}|${last.id}` : null,
	};
}
