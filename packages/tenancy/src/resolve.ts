import { and, asc, eq } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { apikey, member } from "@reactive-resume/db/schema";
import { TenancyError } from "./errors";
import { type HostContext } from "./host";

export type SessionOrgSource = { userId: string; activeOrganizationId?: string | null | undefined };
/** `organizationId` is the `apikey.organization_id` column of the verified key. */
export type ApiKeyOrgSource = { userId: string; organizationId?: string | null | undefined };

export type ResolveOrgInput = {
	session?: SessionOrgSource | null | undefined;
	apiKey?: ApiKeyOrgSource | null | undefined;
};

async function isMember(organizationId: string, userId: string) {
	const [row] = await db
		.select({ id: member.id })
		.from(member)
		.where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
		.limit(1);
	return row !== undefined;
}

/** The user's oldest membership, the same ordering as the sign-in hook. */
async function oldestMembershipOrg(userId: string) {
	const [row] = await db
		.select({ organizationId: member.organizationId })
		.from(member)
		.where(eq(member.userId, userId))
		.orderBy(asc(member.createdAt), asc(member.id))
		.limit(1);
	return row?.organizationId;
}

/**
 * The organization a request acts in, taken only from authenticated server state: the key's organization for API-key
 * authentication, otherwise the session's active organization. Either must be backed by a `member` row for the
 * authenticated user. Headers, query and body are never inputs. Returns `undefined` when there is none.
 */
export async function resolveOrgForRequest(input: ResolveOrgInput): Promise<string | undefined> {
	const source = input.apiKey
		? { userId: input.apiKey.userId, organizationId: input.apiKey.organizationId }
		: input.session
			? { userId: input.session.userId, organizationId: input.session.activeOrganizationId }
			: undefined;
	if (!source?.organizationId) return undefined;
	return (await isMember(source.organizationId, source.userId)) ? source.organizationId : undefined;
}

/** The parts of an authenticated request that name an organization (structurally compatible with the API's context). */
export type AuthenticationOrgSource = {
	// CAREEROS (P5-T02): a Job Clipper token acts only in the organization it was issued for, on that organization's hosts.
	method: "apiKey" | "bearer" | "session" | "clipper";
	clipper?: { organizationId: string } | undefined;
	user: { id: string };
	activeOrganizationId?: string | null | undefined;
	apiKeyId?: string | undefined;
};

/**
 * Resolves the organization for an authenticated request.
 *
 * Platform host (and any host that is not an organization host; `host` omitted): the verified API key's
 * `organization_id`, or the session's active organization, each after the membership check; keys and OAuth tokens
 * without an organization fall back to the owner's oldest membership (Phase 1 behaviour).
 *
 * Organization host (P2-T03, D4): the host's organization decides, never the session's active organization. A session
 * must belong to it, an API key bound to another organization is refused, and a key or token without an organization
 * acts in the host's organization if its owner is a member. Failures throw a `TenancyError`.
 */
export async function resolveOrgForAuthentication(
	authentication: AuthenticationOrgSource,
	host?: HostContext,
): Promise<string | undefined> {
	// CAREEROS (P5-T02): fail closed. A clipper token never falls back to a membership or to the platform rules.
	if (authentication.method === "clipper") {
		if (host?.kind !== "org" || host.organizationId !== authentication.clipper?.organizationId)
			throw new TenancyError("key_org_mismatch");
	}
	if (host?.kind === "org") return resolveOrgOnOrgHost(authentication, host.organizationId);
	// A host that has the shape of an organization host but names none must not fall back to the platform rules.
	if (host?.kind === "unknown" && host.matchesOrgPattern) throw new TenancyError("unknown_org_host");
	if (authentication.method === "apiKey") {
		if (!authentication.apiKeyId) return undefined;
		const key = await apiKeyOrganization(authentication.apiKeyId);
		const resolved = await resolveOrgForRequest({
			apiKey: { userId: authentication.user.id, organizationId: key?.organizationId },
		});
		if (resolved || key?.organizationId) return resolved;
		// CAREEROS: a key without an organization falls back to its owner's oldest membership. Phase 2 replaces this
		// with org-bound keys and tokens (P1-T04 review 1, M1).
		return oldestMembershipOrg(authentication.user.id);
	}
	if (authentication.method === "session") {
		return resolveOrgForRequest({
			session: { userId: authentication.user.id, activeOrganizationId: authentication.activeOrganizationId },
		});
	}
	// CAREEROS: OAuth bearer tokens carry no organization; fall back to the token owner's oldest membership and fail
	// closed (undefined) when the user has none. Phase 2 replaces this with org-bound tokens (P1-T04 review 1, M1).
	return oldestMembershipOrg(authentication.user.id);
}

async function apiKeyOrganization(apiKeyId: string) {
	const [key] = await db
		.select({ organizationId: apikey.organizationId })
		.from(apikey)
		.where(eq(apikey.id, apiKeyId))
		.limit(1);
	return key;
}

/** CAREEROS (P2-T03): the rules of an organization host. Only the resolved host organization is ever returned. */
async function resolveOrgOnOrgHost(
	authentication: AuthenticationOrgSource,
	hostOrganizationId: string,
): Promise<string | undefined> {
	if (authentication.method === "apiKey") {
		if (!authentication.apiKeyId) return undefined;
		const key = await apiKeyOrganization(authentication.apiKeyId);
		if (key?.organizationId && key.organizationId !== hostOrganizationId) throw new TenancyError("key_org_mismatch");
	}
	// Session, key and token alike: the user must be a member of the host organization. A session's active
	// organization is ignored here.
	if (!(await isMember(hostOrganizationId, authentication.user.id))) throw new TenancyError("not_member_of_host_org");
	return hostOrganizationId;
}
