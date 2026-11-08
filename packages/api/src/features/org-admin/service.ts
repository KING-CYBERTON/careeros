import type { InviteFacts, InviteRowResult } from "./bulk-rules";
import type { CohortCreateInput, CohortUpdateInput } from "./schemas";
import {
	audit,
	EntitlementError,
	getEntitlements,
	isSeatLimitDatabaseError,
	runWithEntitlementsCache,
	type AuditContext,
} from "@careeros/billing";
import { requireOrgId } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, asc, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { auth } from "@reactive-resume/auth/config";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { evaluateInviteRows, summarizeInviteRows } from "./bulk-rules";
import { CsvError, parseInviteCsv } from "./csv";
import { MEMBER_PAGE_SIZE } from "./schemas";

// CAREEROS (P3-T08, phase plan D8): the Org Admin console. Every function runs inside the request's organization
// scope (`protectedProcedure`), so row-level security confines what it reads and writes on tenant tables; `member`,
// `invitation` and `session` are not tenant tables, so each query on them names the organization itself. The
// organization id is never a parameter: it is `requireOrgId()`.

/** The Postgres error code behind a driver error, which Drizzle wraps in `cause`. */
function pgCode(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

export type AdminActor = { userId: string; ip?: string | null };

const auditContext = (actor: AdminActor): AuditContext => ({ actorUserId: actor.userId, ip: actor.ip ?? null });

/**
 * Owners and admins of an organization that is not a personal workspace (phase plan D8). The role comes from `member`
 * and the plan from the organization, never from the client. Returns the organization id.
 */
export async function requireOrgAdmin(userId: string): Promise<string> {
	const organizationId = requireOrgId();
	const [membership] = await db
		.select({ role: schema.member.role })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
		.limit(1);
	// Better Auth stores several roles as a comma separated list.
	const roles = membership?.role.split(",").map((role) => role.trim()) ?? [];
	if (!roles.includes("owner") && !roles.includes("admin"))
		throw new ORPCError("FORBIDDEN", {
			message: "Only an owner or admin of the organization can do this.",
			data: { code: "ORG_ADMIN_REQUIRED" },
		});
	const entitlements = await getEntitlements(organizationId);
	if (entitlements.planId === "personal")
		throw new ORPCError("FORBIDDEN", {
			message: "A personal workspace has no admin console. Create an organization to manage a team.",
			data: { code: "PERSONAL_WORKSPACE" },
		});
	return organizationId;
}

// ---------------------------------------------------------------------------------------------------------------
// Cohorts

const cohortColumns = {
	id: schema.cohort.id,
	name: schema.cohort.name,
	description: schema.cohort.description,
	startsOn: schema.cohort.startsOn,
	endsOn: schema.cohort.endsOn,
	archivedAt: schema.cohort.archivedAt,
	createdAt: schema.cohort.createdAt,
	updatedAt: schema.cohort.updatedAt,
};

export async function listCohorts(userId: string, input: { includeArchived?: boolean | undefined }) {
	const organizationId = await requireOrgAdmin(userId);
	const rows = await db
		.select({ ...cohortColumns, memberCount: count(schema.member.id) })
		.from(schema.cohort)
		.leftJoin(
			schema.member,
			and(eq(schema.member.organizationId, schema.cohort.organizationId), eq(schema.member.cohortId, schema.cohort.id)),
		)
		.where(
			and(
				eq(schema.cohort.organizationId, organizationId),
				input.includeArchived ? undefined : isNull(schema.cohort.archivedAt),
			),
		)
		.groupBy(schema.cohort.id)
		.orderBy(asc(sql`lower(${schema.cohort.name})`), asc(schema.cohort.id));
	return rows;
}

function cohortWriteError(error: unknown): unknown {
	const code = pgCode(error);
	if (code === "23505")
		return new ORPCError("CONFLICT", {
			message: "A cohort with this name already exists.",
			data: { code: "COHORT_NAME_TAKEN" },
		});
	if (code === "23514")
		return new ORPCError("BAD_REQUEST", { message: "The end date must not be before the start date." });
	return error;
}

async function getCohortRow(organizationId: string, id: string) {
	const [row] = await db
		.select({ ...cohortColumns, memberCount: sql<number>`0`.mapWith(Number) })
		.from(schema.cohort)
		.where(and(eq(schema.cohort.organizationId, organizationId), eq(schema.cohort.id, id)))
		.limit(1);
	if (!row) throw new ORPCError("NOT_FOUND", { message: "Cohort not found." });
	const [{ n } = { n: 0 }] = await db
		.select({ n: count() })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.cohortId, id)));
	return { ...row, memberCount: n };
}

export async function createCohort(actor: AdminActor, input: CohortCreateInput) {
	const organizationId = await requireOrgAdmin(actor.userId);
	try {
		const [row] = await db
			.insert(schema.cohort)
			.values({
				organizationId,
				name: input.name,
				description: input.description ?? null,
				startsOn: input.startsOn ?? null,
				endsOn: input.endsOn ?? null,
			})
			.returning({ id: schema.cohort.id });
		if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR");
		await audit(auditContext(actor), "cohort.created", { type: "cohort", id: row.id });
		return await getCohortRow(organizationId, row.id);
	} catch (error) {
		throw cohortWriteError(error);
	}
}

export async function updateCohort(actor: AdminActor, input: CohortUpdateInput) {
	const organizationId = await requireOrgAdmin(actor.userId);
	const values = {
		...(input.name !== undefined && { name: input.name }),
		...(input.description !== undefined && { description: input.description }),
		...(input.startsOn !== undefined && { startsOn: input.startsOn }),
		...(input.endsOn !== undefined && { endsOn: input.endsOn }),
	};
	try {
		if (Object.keys(values).length > 0) {
			const updated = await db
				.update(schema.cohort)
				.set({ ...values, updatedAt: new Date() })
				.where(and(eq(schema.cohort.organizationId, organizationId), eq(schema.cohort.id, input.id)))
				.returning({ id: schema.cohort.id });
			if (updated.length === 0) throw new ORPCError("NOT_FOUND", { message: "Cohort not found." });
			await audit(
				auditContext(actor),
				"cohort.updated",
				{ type: "cohort", id: input.id },
				{ fields: Object.keys(values) },
			);
		}
		return await getCohortRow(organizationId, input.id);
	} catch (error) {
		throw cohortWriteError(error);
	}
}

export async function archiveCohort(actor: AdminActor, input: { id: string; archived?: boolean | undefined }) {
	const organizationId = await requireOrgAdmin(actor.userId);
	const archived = input.archived ?? true;
	const updated = await db
		.update(schema.cohort)
		.set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
		.where(and(eq(schema.cohort.organizationId, organizationId), eq(schema.cohort.id, input.id)))
		.returning({ id: schema.cohort.id });
	if (updated.length === 0) throw new ORPCError("NOT_FOUND", { message: "Cohort not found." });
	await audit(auditContext(actor), archived ? "cohort.archived" : "cohort.restored", { type: "cohort", id: input.id });
	return await getCohortRow(organizationId, input.id);
}

// ---------------------------------------------------------------------------------------------------------------
// Members

export async function listMembers(userId: string, input: { page?: number | undefined; cohortId?: string | undefined }) {
	const organizationId = await requireOrgAdmin(userId);
	const page = input.page ?? 1;
	const where = and(
		eq(schema.member.organizationId, organizationId),
		input.cohortId ? eq(schema.member.cohortId, input.cohortId) : undefined,
	);
	const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(schema.member).where(where);
	const items = await db
		.select({
			memberId: schema.member.id,
			userId: schema.member.userId,
			name: schema.user.name,
			email: schema.user.email,
			role: schema.member.role,
			cohortId: schema.member.cohortId,
			cohortName: schema.cohort.name,
			joinedAt: schema.member.createdAt,
		})
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
		.leftJoin(
			schema.cohort,
			and(eq(schema.cohort.organizationId, schema.member.organizationId), eq(schema.cohort.id, schema.member.cohortId)),
		)
		.where(where)
		.orderBy(asc(sql`lower(${schema.user.name})`), asc(schema.member.id))
		.limit(MEMBER_PAGE_SIZE)
		.offset((page - 1) * MEMBER_PAGE_SIZE);
	return { items, total, page, pageSize: MEMBER_PAGE_SIZE };
}

/** Moves members into a cohort, or out of theirs with `null`. Ids that are not members of this organization are skipped. */
export async function setMemberCohort(actor: AdminActor, input: { memberIds: string[]; cohortId: string | null }) {
	const organizationId = await requireOrgAdmin(actor.userId);
	if (input.cohortId !== null) {
		const [target] = await db
			.select({ id: schema.cohort.id, archivedAt: schema.cohort.archivedAt })
			.from(schema.cohort)
			.where(and(eq(schema.cohort.organizationId, organizationId), eq(schema.cohort.id, input.cohortId)))
			.limit(1);
		if (!target) throw new ORPCError("NOT_FOUND", { message: "Cohort not found." });
		if (target.archivedAt)
			throw new ORPCError("BAD_REQUEST", { message: "This cohort is archived. Restore it first." });
	}
	const ids = [...new Set(input.memberIds)];
	const updated = await db
		.update(schema.member)
		.set({ cohortId: input.cohortId })
		.where(and(eq(schema.member.organizationId, organizationId), inArray(schema.member.id, ids)))
		.returning({ id: schema.member.id });
	await audit(
		auditContext(actor),
		"members.cohort_set",
		input.cohortId ? { type: "cohort", id: input.cohortId } : null,
		{ requested: ids.length, updated: updated.length },
	);
	return { updated: updated.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Bulk invitations

/** The facts the row rules need, read for the emails of this file only. */
async function gatherInviteFacts(organizationId: string, emails: string[]): Promise<InviteFacts> {
	const unique = [...new Set(emails)];
	// One after the other: inside an organization scope all queries share one connection.
	const members =
		unique.length === 0
			? []
			: await db
					.select({ email: schema.user.email })
					.from(schema.member)
					.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
					.where(
						and(eq(schema.member.organizationId, organizationId), inArray(sql`lower(${schema.user.email})`, unique)),
					);
	const invited =
		unique.length === 0
			? []
			: await db
					.select({ email: schema.invitation.email })
					.from(schema.invitation)
					.where(
						and(
							eq(schema.invitation.organizationId, organizationId),
							eq(schema.invitation.status, "pending"),
							gt(schema.invitation.expiresAt, new Date()),
							inArray(sql`lower(${schema.invitation.email})`, unique),
						),
					);
	const cohorts = await db
		.select({ id: schema.cohort.id, name: schema.cohort.name })
		.from(schema.cohort)
		.where(and(eq(schema.cohort.organizationId, organizationId), isNull(schema.cohort.archivedAt)));
	const entitlements = await getEntitlements(organizationId);
	return {
		memberEmails: new Set(members.map((row) => row.email.toLowerCase())),
		invitedEmails: new Set(invited.map((row) => row.email.toLowerCase())),
		cohortsByName: new Map(cohorts.map((row) => [row.name.toLowerCase(), row.id])),
		freeSeats: entitlements.seatLimit === null ? null : Math.max(0, entitlements.seatLimit - entitlements.seatsUsed),
	};
}

function readInviteFile(bytes: Uint8Array) {
	try {
		return parseInviteCsv(bytes);
	} catch (error) {
		if (error instanceof CsvError)
			throw new ORPCError("BAD_REQUEST", { message: error.message, data: { code: `CSV_${error.code.toUpperCase()}` } });
		throw error;
	}
}

const publicRow = (row: InviteRowResult) => ({
	line: row.line,
	email: row.email,
	role: row.role,
	cohort: row.cohort,
	status: row.status,
});

async function inviteReport(organizationId: string, results: InviteRowResult[], sent: number) {
	// A fresh read: the request's cached entitlements predate the invitations this call just made.
	const entitlements = await runWithEntitlementsCache(() => getEntitlements(organizationId));
	return {
		rows: results.map(publicRow),
		counts: summarizeInviteRows(results),
		seatLimit: entitlements.seatLimit,
		seatsUsed: entitlements.seatsUsed,
		sent,
	};
}

/** The dry run: what each row would do. Sends nothing and writes nothing. */
export async function previewBulkInvites(userId: string, bytes: Uint8Array) {
	const organizationId = await requireOrgAdmin(userId);
	const rows = readInviteFile(bytes);
	const results = evaluateInviteRows(
		rows,
		await gatherInviteFacts(
			organizationId,
			rows.map((row) => row.email.toLowerCase()),
		),
	);
	return inviteReport(organizationId, results, 0);
}

/** Better Auth's error code, or the entitlement code, behind a refusal of `createInvitation`. */
function refusalCode(error: unknown): string | undefined {
	if (isSeatLimitDatabaseError(error)) return "SEAT_LIMIT_REACHED";
	if (error instanceof EntitlementError) return error.code;
	const body = (error as { body?: { code?: unknown } } | null)?.body;
	return typeof body?.code === "string" ? body.code : undefined;
}

export type BulkInviteRequest = {
	actor: AdminActor;
	/** The caller's own headers: Better Auth reads the signed-in session from them. */
	headers: Headers;
	bytes: Uint8Array;
};

/**
 * The confirm call. The file is read and judged again (nothing from the dry run is trusted), then each ok row goes
 * through Better Auth's `createInvitation`, one at a time: the same hooks as a single invitation (suspension, free seat,
 * the branded invitation email) and the same database trigger behind them (SQLSTATE CS001, `SEAT_LIMIT_REACHED`). A row
 * the seat path refuses is reported as `over_seat_limit`, so two confirm calls at once can never pass the limit.
 */
export async function sendBulkInvites(request: BulkInviteRequest) {
	const organizationId = await requireOrgAdmin(request.actor.userId);
	const rows = readInviteFile(request.bytes);
	const results = evaluateInviteRows(
		rows,
		await gatherInviteFacts(
			organizationId,
			rows.map((row) => row.email.toLowerCase()),
		),
	);
	let sent = 0;
	for (const [index, row] of results.entries()) {
		const role = row.role;
		if (row.status !== "ok" || role === null) continue;
		try {
			// Each row gets its own entitlements cache, so the seat hook sees the invitations sent before it. The database
			// trigger stays the backstop for a request that races this one.
			const invitation = await runWithEntitlementsCache(() =>
				auth.api.createInvitation({
					headers: request.headers,
					body: { email: row.email, role, organizationId },
				}),
			);
			if (row.cohortId !== null)
				await db
					.update(schema.invitation)
					.set({ cohortId: row.cohortId })
					.where(and(eq(schema.invitation.organizationId, organizationId), eq(schema.invitation.id, invitation.id)));
			sent++;
		} catch (error) {
			const code = refusalCode(error);
			if (code === "ORG_SUSPENDED")
				throw new ORPCError("FORBIDDEN", { message: "This organization is suspended.", data: { code } });
			results[index] = {
				...row,
				status:
					code === "SEAT_LIMIT_REACHED"
						? "over_seat_limit"
						: code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION"
							? "already_member"
							: code === "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION"
								? "already_invited"
								: "send_failed",
			};
		}
	}
	const report = await inviteReport(organizationId, results, sent);
	// One row for the whole upload: counts only, never the addresses.
	await audit(auditContext(request.actor), "invitations.bulk_sent", null, {
		rows: results.length,
		sent,
		counts: report.counts,
	});
	return report;
}
