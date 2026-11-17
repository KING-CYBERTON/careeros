// CAREEROS (P1-T04): public resume pages, files and counters run without a session, but the resume tables have
// row-level security. Every public path resolves the resume's organization through a security definer function that
// only answers for a public resume (migration 20261101004553_resumes_rls), then runs the existing logic inside
// `withOrgContext` for that organization. Nothing here trusts an organization id from the client.
import type { ResumeMatch } from "./slugs";
import { currentOrgId, resolveOrgForAuthentication, withOrgContext } from "@careeros/tenancy";
import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";

async function scalar(query: ReturnType<typeof sql>): Promise<string | undefined> {
	const result = await db.execute<{ org: string | null }>(query);
	return result.rows[0]?.org ?? undefined;
}

/**
 * The organization of the public resume `match` names, or `undefined` when no public resume matches (private,
 * Trash, banned owner, unknown address). A current slug wins over another resume's redirect, as in `findResume`.
 */
export async function lookupPublicResumeOrg(match: ResumeMatch): Promise<string | undefined> {
	if ("id" in match) return scalar(sql`select public.careeros_public_resume_org_by_id(${match.id}) as org`);
	if ("primary" in match)
		return scalar(sql`select public.careeros_public_primary_resume_org(${match.username}) as org`);
	return (
		(await scalar(sql`select public.careeros_public_resume_org(${match.username}, ${match.slug}) as org`)) ??
		(await scalar(sql`select public.careeros_public_resume_org_by_redirect(${match.username}, ${match.slug}) as org`))
	);
}

/**
 * The organization of whoever is looking, resolved from the request's own credentials (session, API key). Used only
 * as a fallback for an owner who opens their own unpublished resume or its preview; membership is checked.
 */
export async function viewerOrganizationId(requestHeaders: Headers): Promise<string | undefined> {
	const { resolveAuthenticationFromRequestHeaders } = await import("../../context");
	const authentication = await resolveAuthenticationFromRequestHeaders(requestHeaders).catch(() => null);
	return authentication ? resolveOrgForAuthentication(authentication) : undefined;
}

type PublicScopeOptions = {
	/** Asked only when no public resume matches: the viewer's own organization (see `viewerOrganizationId`). */
	fallbackOrganizationId?: (() => Promise<string | undefined>) | undefined;
};

/**
 * Runs `fn` inside the organization of the public resume `match` names. When none matches and a fallback is given,
 * the viewer's organization is used, so an owner still reaches their own private resume; with neither, `fn` runs
 * unscoped and row-level security leaves it nothing to read. Already inside a scope (a protected request), that scope
 * is kept: an organization is never switched mid-request.
 */
export async function withPublicResumeScope<T>(
	match: ResumeMatch,
	fn: () => Promise<T>,
	options: PublicScopeOptions = {},
): Promise<T> {
	if (currentOrgId() !== undefined) return fn();
	const organizationId =
		(await lookupPublicResumeOrg(match)) ??
		(options.fallbackOrganizationId ? await options.fallbackOrganizationId() : undefined);
	return organizationId ? withOrgContext(organizationId, fn) : fn();
}
