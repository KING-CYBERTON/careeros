import { assertSeatAvailable, getEntitlements } from "@careeros/billing";
import { currentHost, type HostContext } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { toEntitlementORPCError } from "../../middleware/entitlements";

// CAREEROS (P2-T03): the "join or switch" page of an organization host. The organization is always the host's, taken
// from the resolved host; no input names one.

type OrgHost = Extract<HostContext, { kind: "org" }>;

function requireOrgHost(host: HostContext | undefined): OrgHost {
	const resolved = host ?? currentHost();
	if (resolved?.kind !== "org")
		throw new ORPCError("NOT_FOUND", { message: "This address does not belong to an organization." });
	return resolved;
}

async function isMember(organizationId: string, userId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: schema.member.id })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
		.limit(1);
	return row !== undefined;
}

/**
 * CAREEROS (P2-T06, Q94): whether the organization lets anyone join. The caller is usually not a member yet, so no
 * organization scope is opened for them: a definer function answers one boolean for the host's organization.
 */
async function hasOpenSignup(organizationId: string): Promise<boolean> {
	const { rows } = await db.execute<{ open: boolean | null }>(
		sql`select careeros_org_open_signup(${organizationId}::text) as open`,
	);
	return rows[0]?.open === true;
}

/** Whether the caller is a member of the host organization and whether anyone may join it. */
export async function getHostStatus(userId: string, host: HostContext | undefined) {
	const orgHost = requireOrgHost(host);
	const [member, openSignup] = await Promise.all([
		isMember(orgHost.organizationId, userId),
		hasOpenSignup(orgHost.organizationId),
	]);
	return { slug: orgHost.slug, isMember: member, openSignup };
}

/** Adds the caller to the host organization as `member`, when it has open signup and they are not a member yet. */
export async function joinHostOrganization(userId: string, host: HostContext | undefined) {
	const orgHost = requireOrgHost(host);
	if (!(await hasOpenSignup(orgHost.organizationId)))
		throw new ORPCError("FORBIDDEN", {
			message: "This organization is invite only. Ask its administrator for an invitation.",
			data: { code: "ORG_SIGNUP_CLOSED" },
		});
	// CAREEROS (P3-T02): an open-signup join takes a seat like an accepted invitation does. A member who is already in
	// gets the CONFLICT below, not a seat error, so check membership first.
	if (await isMember(orgHost.organizationId, userId)) {
		// The seat trigger runs before the unique index is checked, so a member of a full organization is answered here.
		throw new ORPCError("CONFLICT", { message: "You are already a member of this organization." });
	} else {
		try {
			assertSeatAvailable(await getEntitlements(orgHost.organizationId));
		} catch (error) {
			throw toEntitlementORPCError(error);
		}
	}
	// The unique (organization, user) index settles a race between two requests: the loser inserts nothing.
	// CAREEROS (P3-T02): the database trigger refuses a member past the seat limit even when requests race.
	const inserted = await db
		.insert(schema.member)
		.values({ organizationId: orgHost.organizationId, userId, role: "member" })
		.onConflictDoNothing()
		.returning({ id: schema.member.id })
		.catch((error: unknown) => {
			throw toEntitlementORPCError(error);
		});
	if (inserted.length === 0)
		throw new ORPCError("CONFLICT", { message: "You are already a member of this organization." });
	return { slug: orgHost.slug, isMember: true as const };
}
