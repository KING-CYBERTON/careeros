import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

// CareerOS (P1-T03, phase plan D6): until host-based organizations arrive in Phase 2, every user has at least one
// organization. This file holds the logic; `packages/auth/src/config.ts` only calls into it.

type NewUser = { id: string; email: string; name?: string | null; username?: string | null };
type SignUpContext = { body?: unknown } | null | undefined;

const MAX_ORGANIZATION_NAME_LENGTH = 100;

/** The shared reason account deletion is refused while the user owns an organization that has other members. */
export const TRANSFER_OWNERSHIP_MESSAGE =
	"You own an organization that has other members. Transfer ownership first, then delete your account.";

function invitationIdFromContext(context: SignUpContext): string | undefined {
	const body = context?.body;
	if (typeof body !== "object" || body === null) return undefined;
	const value = (body as { invitationId?: unknown }).invitationId;
	return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}

/**
 * A sign-up counts as invited only with both an `invitationId` in the sign-up request and a pending, unexpired
 * invitation with that id for the new user's email. Either alone is not enough (an id for another address is ignored).
 */
async function isInvitedSignUp(user: NewUser, context: SignUpContext): Promise<boolean> {
	const invitationId = invitationIdFromContext(context);
	if (!invitationId) return false;
	const [row] = await db
		.select({ id: schema.invitation.id })
		.from(schema.invitation)
		.where(
			and(
				eq(schema.invitation.id, invitationId),
				eq(schema.invitation.status, "pending"),
				gt(schema.invitation.expiresAt, new Date()),
				sql`lower(${schema.invitation.email}) = lower(${user.email})`,
			),
		)
		.limit(1);
	return row !== undefined;
}

/** Creates the user's personal organization (they become `owner`), unless they are signing up through an invitation. */
export async function createPersonalOrganization(user: NewUser, context: SignUpContext): Promise<void> {
	if (await isInvitedSignUp(user, context)) return;

	const displayName = user.name?.trim() || user.username?.trim() || "My";
	const name = `${displayName}'s workspace`.slice(0, MAX_ORGANIZATION_NAME_LENGTH);
	const slug = `u-${user.id.slice(-12)}`;
	await db.transaction(async (tx) => {
		const [organization] = await tx.insert(schema.organization).values({ name, slug }).returning({
			id: schema.organization.id,
		});
		if (!organization) throw new Error("Personal organization was not created.");
		await tx.insert(schema.member).values({ organizationId: organization.id, userId: user.id, role: "owner" });
		// Better Auth runs this hook after the endpoint finishes, so the sign-up session already exists without an
		// active organization. Give it the new one.
		await tx
			.update(schema.session)
			.set({ activeOrganizationId: organization.id })
			.where(and(eq(schema.session.userId, user.id), isNull(schema.session.activeOrganizationId)));
	});
}

/** The user's oldest membership, which becomes the active organization of a session that has none. */
export async function oldestOrganizationId(userId: string): Promise<string | undefined> {
	const [row] = await db
		.select({ organizationId: schema.member.organizationId })
		.from(schema.member)
		.where(eq(schema.member.userId, userId))
		.orderBy(asc(schema.member.createdAt), asc(schema.member.id))
		.limit(1);
	return row?.organizationId;
}

/** Hook body for a new session: fills `activeOrganizationId` when it is empty and the user has a membership. */
export async function withDefaultActiveOrganization<T extends { userId: string; activeOrganizationId?: unknown }>(
	session: T,
): Promise<{ data: T & { activeOrganizationId: string } } | undefined> {
	if (session.activeOrganizationId) return undefined;
	const organizationId = await oldestOrganizationId(session.userId);
	return organizationId ? { data: { ...session, activeOrganizationId: organizationId } } : undefined;
}

type Executor = Pick<typeof db, "select" | "delete">;

/** Organizations the user is the only member of. */
async function soleMemberOrganizationIds(executor: Executor, userId: string): Promise<string[]> {
	const mine = await executor
		.select({ organizationId: schema.member.organizationId })
		.from(schema.member)
		.where(eq(schema.member.userId, userId));
	const ids = mine.map((row) => row.organizationId);
	if (ids.length === 0) return [];
	const shared = await executor
		.select({ organizationId: schema.member.organizationId })
		.from(schema.member)
		.where(and(inArray(schema.member.organizationId, ids), ne(schema.member.userId, userId)));
	const sharedIds = new Set(shared.map((row) => row.organizationId));
	return ids.filter((id) => !sharedIds.has(id));
}

/** Throws when the user is the last owner of an organization that has other members (ownership transfer UI is Phase 3). */
export async function assertNoSharedOrganizationOwnership(userId: string, executor: Executor = db): Promise<void> {
	const mine = await executor
		.select({ organizationId: schema.member.organizationId, role: schema.member.role })
		.from(schema.member)
		.where(eq(schema.member.userId, userId));
	const ownedIds = mine.filter((row) => row.role.split(",").includes("owner")).map((row) => row.organizationId);
	if (ownedIds.length === 0) return;
	const others = await executor
		.select({ organizationId: schema.member.organizationId, role: schema.member.role })
		.from(schema.member)
		.where(and(inArray(schema.member.organizationId, ownedIds), ne(schema.member.userId, userId)));
	for (const organizationId of ownedIds) {
		const members = others.filter((row) => row.organizationId === organizationId);
		const anotherOwner = members.some((row) => row.role.split(",").includes("owner"));
		if (members.length > 0 && !anotherOwner) throw new SharedOrganizationOwnerError();
	}
}

export class SharedOrganizationOwnerError extends Error {
	constructor() {
		super(TRANSFER_OWNERSHIP_MESSAGE);
		this.name = "SharedOrganizationOwnerError";
	}
}

/** Deletes the organizations where the user is the only member (cascades members and invitations). */
export async function deleteSoleMemberOrganizations(userId: string, executor: Executor = db): Promise<void> {
	const ids = await soleMemberOrganizationIds(executor, userId);
	if (ids.length > 0) await executor.delete(schema.organization).where(inArray(schema.organization.id, ids));
}
