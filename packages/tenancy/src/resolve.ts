import { and, eq } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { apikey, member } from "@reactive-resume/db/schema";

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
	method: "apiKey" | "bearer" | "session";
	user: { id: string };
	activeOrganizationId?: string | null | undefined;
	apiKeyId?: string | undefined;
};

/**
 * Resolves the organization for an authenticated request: the verified API key's `organization_id`, or the session's
 * active organization, each after the membership check. OAuth bearer tokens carry no organization and resolve to none.
 */
export async function resolveOrgForAuthentication(
	authentication: AuthenticationOrgSource,
): Promise<string | undefined> {
	if (authentication.method === "apiKey") {
		if (!authentication.apiKeyId) return undefined;
		const [key] = await db
			.select({ organizationId: apikey.organizationId })
			.from(apikey)
			.where(eq(apikey.id, authentication.apiKeyId))
			.limit(1);
		return resolveOrgForRequest({ apiKey: { userId: authentication.user.id, organizationId: key?.organizationId } });
	}
	if (authentication.method === "session") {
		return resolveOrgForRequest({
			session: { userId: authentication.user.id, activeOrganizationId: authentication.activeOrganizationId },
		});
	}
	return undefined;
}
