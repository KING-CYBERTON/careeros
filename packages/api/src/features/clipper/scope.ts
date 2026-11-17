import type { RequestAuthentication } from "../../context";
import type { HostContext } from "@careeros/tenancy";
import type { User } from "better-auth";
import { ORPCError } from "@orpc/server";
import { hostMatchesOrganization, isClipperTokenFormat } from "@reactive-resume/auth/clipper-core";
import { auth } from "@reactive-resume/auth/config";

// CAREEROS (P5-T02, phase plan G6): what a Job Clipper token may do. The token is not a session. It is resolved only for
// the oRPC procedures (`publicProcedure` opts in), it works only on the hosts of the organization it was issued for, and
// it reaches only the procedures below. The check lives here, once, where the request's credentials are resolved; no
// procedure has to remember it.

/**
 * The oRPC procedure paths a clipper token may call. `clipper.whoami` answers the member's name and avatar, the
 * organization's name and the token's expiry; `branding.publicForHost` is the organization's public branding;
 * `applications.create` saves a clipped job (P5-T03). Also P5-T03: `clipper.findByUrl` answers whether the member already
 * saved the job (an id and a title, the member's own applications only) and `clipper.cleanup` is the optional, metered AI
 * tidy (platform provider only). Anything else answers 403.
 */
export const CLIPPER_ALLOWED_PROCEDURES: ReadonlySet<string> = new Set([
	"clipper.whoami",
	"branding.publicForHost",
	"applications.create",
	"clipper.findByUrl",
	"clipper.cleanup",
]);

/** The permissions a clipper token carries: it can read and write what the allow-list reaches, and never delete. */
const CLIPPER_PERMISSIONS = ["read", "write"] as const;

/** Throws 403 when `authentication` is a clipper token and `path` (the router path) is not on the allow-list. */
export function assertClipperProcedureAllowed(
	authentication: Pick<RequestAuthentication, "method"> | null | undefined,
	path: readonly string[],
): void {
	if (authentication?.method !== "clipper") return;
	if (CLIPPER_ALLOWED_PROCEDURES.has(path.join("."))) return;
	throw new ORPCError("FORBIDDEN", {
		message: "The Job Clipper's sign-in cannot be used for this.",
		data: { code: "CLIPPER_SCOPE" },
	});
}

/**
 * The authentication of a request that carries a clipper token, `null` when it carries none. A token that does not
 * verify (unknown, expired, revoked, or issued for another organization than the request host's) is a 401, never a
 * fall-back to cookies. The request host is the one the server adapter resolved; without one, the token is refused.
 */
export async function resolveClipperAuthentication(
	headers: Headers,
	host: HostContext | undefined,
	findActiveUser: (id: string) => Promise<User | null>,
): Promise<RequestAuthentication | null> {
	const header = headers.get("authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const token = header.slice(7).trim();
	if (!isClipperTokenFormat(token)) return null;

	const unauthorized = () => new ORPCError("UNAUTHORIZED", { message: "Sign in to the Job Clipper again." });
	if (host?.kind !== "org" || !hostMatchesOrganization(host, host.organizationId)) throw unauthorized();
	const row = await auth.api
		.clipperVerifyToken({ body: { token, organizationId: host.organizationId } })
		.catch(() => null);
	if (!row) throw unauthorized();
	const user = await findActiveUser(row.userId);
	if (!user) throw unauthorized();
	return {
		user,
		method: "clipper",
		permissions: CLIPPER_PERMISSIONS,
		activeOrganizationId: row.organizationId,
		clipper: { tokenId: row.id, organizationId: row.organizationId, expiresAt: row.expiresAt },
	};
}
