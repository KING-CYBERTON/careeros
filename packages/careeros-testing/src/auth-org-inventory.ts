// CareerOS (P1-Q10): the endpoint inventory and the attack requests for the cross-organization fuzz of the Better Auth
// organization plugin (`/api/auth/organization/*`).
//
// Pure logic with no application imports. The e2e spec feeds it the schema that the running auth instance publishes
// at `/api/auth/open-api/generate-schema` (the openAPI plugin is registered in packages/auth/src/config.ts), and a
// unit test in packages/auth feeds it the same schema from `auth.handler`. Nothing here lists the endpoints that
// exist, so an endpoint added by a plugin upgrade or a new option fails the inventory check until it is attacked or
// skipped with a reason.

type AuthOperation = {
	parameters?: { in?: string; name: string }[];
	requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> };
};

export type AuthOpenApiDocument = { paths: Record<string, Record<string, AuthOperation>> };

export type AuthOrgEndpoint = {
	/** "METHOD /organization/path": the stable name used by the skip list, the attacks and the failure messages. */
	key: string;
	method: "GET" | "POST";
	path: string;
	/** Names of the query and body fields the endpoint accepts. */
	fields: string[];
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Every operation under `/organization/` in the published schema. */
export function readOrganizationEndpoints(document: AuthOpenApiDocument): AuthOrgEndpoint[] {
	const endpoints: AuthOrgEndpoint[] = [];
	for (const [path, item] of Object.entries(document.paths)) {
		if (!path.startsWith("/organization/")) continue;
		for (const method of HTTP_METHODS) {
			const operation = item[method];
			if (!operation) continue;
			const fields = new Set<string>();
			for (const parameter of operation.parameters ?? []) fields.add(parameter.name);
			for (const content of Object.values(operation.requestBody?.content ?? {}))
				for (const name of Object.keys(content.schema?.properties ?? {})) fields.add(name);
			endpoints.push({
				key: `${method.toUpperCase()} ${path}`,
				method: method.toUpperCase() as "GET" | "POST",
				path,
				fields: [...fields].sort(),
			});
		}
	}
	return endpoints.sort((left, right) => left.key.localeCompare(right.key));
}

/** The only valid reason to skip an endpoint (spec P1-Q10, requirement 2). */
export const SKIP_REASON = "takes no organization, member or invitation id";

/**
 * Endpoints that are not attacked. Each takes no organization, member or invitation id, so there is nothing of
 * Organization A's to present. The spec still sweeps the GET ones for leaks.
 */
export const AUTH_ORG_SKIP: Record<string, string> = {
	"POST /organization/create": SKIP_REASON,
	"GET /organization/list": SKIP_REASON,
	"GET /organization/get-active-member": SKIP_REASON,
};

/** Endpoints the plugin registers without an HTTP path (`auth.api` only). They must answer 404 over HTTP. */
export const AUTH_ORG_SERVER_ONLY = ["POST /organization/add-member"];

/** Organization A's identifiers, plus two of Organization B's, as the attacks need them. */
export type AuthOrgSeed = {
	orgId: string;
	orgSlug: string;
	ownerUserId: string;
	ownerMemberId: string;
	memberUserId: string;
	memberEmail: string;
	memberId: string;
	invitationId: string;
	invitationEmail: string;
	/** Organization B's own organization and B's member row in it (for the confused-deputy variants). */
	bOrgId: string;
	bUserId: string;
	bMemberId: string;
	tag: string;
};

export type AuthOrgAttack = {
	label: string;
	method: "GET" | "POST";
	path: string;
	query?: Record<string, string>;
	body?: Record<string, unknown>;
};

type Builder = (seed: AuthOrgSeed) => Omit<AuthOrgAttack, "method" | "path">[];

/** The attacks per endpoint. Both `organizationId` and `organizationSlug` forms wherever the endpoint takes them. */
const ATTACKS: Record<string, Builder> = {
	"GET /organization/get-organization": (s) => [
		{ label: "by id", query: { organizationId: s.orgId } },
		{ label: "by slug", query: { organizationSlug: s.orgSlug } },
	],
	"GET /organization/get-full-organization": (s) => [
		{ label: "by id", query: { organizationId: s.orgId } },
		{ label: "by slug", query: { organizationSlug: s.orgSlug } },
		{ label: "by id with members limit", query: { organizationId: s.orgId, membersLimit: "100" } },
	],
	"GET /organization/list-members": (s) => [
		{ label: "by id", query: { organizationId: s.orgId } },
		{ label: "by slug", query: { organizationSlug: s.orgSlug } },
		{
			label: "by id, filtered to one member",
			query: { organizationId: s.orgId, filterField: "userId", filterValue: s.memberUserId },
		},
	],
	"GET /organization/list-invitations": (s) => [{ label: "by id", query: { organizationId: s.orgId } }],
	"GET /organization/get-invitation": (s) => [{ label: "by invitation id", query: { id: s.invitationId } }],
	"GET /organization/get-active-member-role": (s) => [
		{ label: "by id", query: { organizationId: s.orgId } },
		{ label: "by slug", query: { organizationSlug: s.orgSlug } },
		{ label: "by id for another user", query: { organizationId: s.orgId, userId: s.memberUserId } },
	],
	"GET /organization/list-user-invitations": (s) => [
		{ label: "for the invited address", query: { email: s.invitationEmail } },
		{ label: "for a member's address", query: { email: s.memberEmail } },
	],
	"POST /organization/check-slug": (s) => [{ label: "A's slug", body: { slug: s.orgSlug } }],
	"POST /organization/update": (s) => [
		{ label: "rename by id", body: { organizationId: s.orgId, data: { name: `Hijacked ${s.tag}` } } },
		{ label: "reslug by id", body: { organizationId: s.orgId, data: { slug: `hijacked-${s.tag}` } } },
	],
	"POST /organization/delete": (s) => [{ label: "by id", body: { organizationId: s.orgId } }],
	"POST /organization/set-active": (s) => [
		{ label: "by id", body: { organizationId: s.orgId } },
		{ label: "by slug", body: { organizationSlug: s.orgSlug } },
	],
	"POST /organization/invite-member": (s) => [
		{
			label: "as admin",
			body: { email: `xorgb${s.tag}_intruder@example.test`, role: "admin", organizationId: s.orgId },
		},
		{
			label: "as owner",
			body: { email: `xorgb${s.tag}_intruder@example.test`, role: "owner", organizationId: s.orgId },
		},
	],
	"POST /organization/cancel-invitation": (s) => [
		{ label: "by invitation id", body: { invitationId: s.invitationId } },
	],
	"POST /organization/accept-invitation": (s) => [
		{ label: "by invitation id", body: { invitationId: s.invitationId } },
	],
	"POST /organization/reject-invitation": (s) => [
		{ label: "by invitation id", body: { invitationId: s.invitationId } },
	],
	"POST /organization/remove-member": (s) => [
		{ label: "member id in A", body: { memberIdOrEmail: s.memberId, organizationId: s.orgId } },
		{ label: "member email in A", body: { memberIdOrEmail: s.memberEmail, organizationId: s.orgId } },
		{ label: "owner id in A", body: { memberIdOrEmail: s.ownerMemberId, organizationId: s.orgId } },
		{ label: "A's member id inside B's organization", body: { memberIdOrEmail: s.memberId, organizationId: s.bOrgId } },
		{
			label: "A's member email inside B's organization",
			body: { memberIdOrEmail: s.memberEmail, organizationId: s.bOrgId },
		},
	],
	"POST /organization/update-member-role": (s) => [
		{ label: "promote A's member in A", body: { memberId: s.memberId, role: "owner", organizationId: s.orgId } },
		{ label: "demote A's owner in A", body: { memberId: s.ownerMemberId, role: "member", organizationId: s.orgId } },
		{
			label: "promote A's member inside B's organization",
			body: { memberId: s.memberId, role: "owner", organizationId: s.bOrgId },
		},
		{
			label: "promote B's own member row against A",
			body: { memberId: s.bMemberId, role: "owner", organizationId: s.orgId },
		},
	],
	"POST /organization/has-permission": (s) => [
		{ label: "delete A", body: { organizationId: s.orgId, permissions: { organization: ["delete"] } } },
		{ label: "manage A's members", body: { organizationId: s.orgId, permissions: { member: ["update", "delete"] } } },
	],
	"POST /organization/leave": (s) => [{ label: "by id", body: { organizationId: s.orgId } }],
	// Server-only in the plugin (no path): the request must not reach a handler.
	"POST /organization/add-member": (s) => [
		{ label: "B into A as owner", body: { userId: s.bUserId, role: "owner", organizationId: s.orgId } },
	],
};

/** The attack requests for one endpoint key, or undefined when the endpoint has no attacks. */
export function attacksFor(key: string, seed: AuthOrgSeed): AuthOrgAttack[] | undefined {
	const build = ATTACKS[key];
	if (!build) return undefined;
	const [method, path] = key.split(" ") as ["GET" | "POST", string];
	return build(seed).map((attack) => ({ ...attack, method, path }));
}

/**
 * Compares the published endpoints with the attacks and the skip list. Returns one line per problem; an empty array
 * means every organization endpoint is either attacked or skipped for the one valid reason.
 */
export function checkAuthOrgInventory(endpoints: AuthOrgEndpoint[]): string[] {
	const problems: string[] = [];
	const keys = new Set(endpoints.map((endpoint) => endpoint.key));
	for (const endpoint of endpoints) {
		const skipped = endpoint.key in AUTH_ORG_SKIP;
		const attacked = endpoint.key in ATTACKS;
		if (skipped && attacked) problems.push(`${endpoint.key} is both attacked and on the skip list`);
		else if (!skipped && !attacked)
			problems.push(`${endpoint.key} is neither attacked nor on the skip list (AUTH_ORG_SKIP)`);
	}
	for (const [key, reason] of Object.entries(AUTH_ORG_SKIP)) {
		if (reason !== SKIP_REASON) problems.push(`${key}: "${reason}" is not a valid skip reason`);
		if (!keys.has(key)) problems.push(`skip list names an unknown endpoint: ${key}`);
	}
	for (const key of Object.keys(ATTACKS))
		if (!keys.has(key) && !AUTH_ORG_SERVER_ONLY.includes(key))
			problems.push(`attacks name an unknown endpoint: ${key}`);
	return problems;
}

// CAREEROS (P2-T05): the sign-in handoff endpoints. They live outside `/api/auth/organization/*`, so the published
// schema does not list them; the inventory is written down here instead, and the e2e fuzz and a unit test both read it.
// User B calls every one on the PLATFORM host with Organization A's identifiers. `begin` and `redeem` are organization
// host endpoints and `request` and `issue` are platform ones, so each answers a fixed refusal here, and none of the
// answers may carry anything of A's.

export const HANDOFF_ENDPOINTS = [
	"POST /api/careeros/handoff/begin",
	"GET /api/careeros/handoff/request/:id",
	"GET /api/careeros/handoff/issue",
	"POST /api/careeros/handoff/redeem",
] as const;

/** Better Auth endpoints registered without a path (`auth.api` only); a guessed HTTP path must answer 404. */
export const HANDOFF_SERVER_ONLY_GUESSES = [
	"/api/auth/careeros-handoff-create-session",
	"/api/auth/careeros-handoff-end-session",
	"/api/auth/careeros/handoff/create-session",
	"/api/auth/careeros/handoff/end-session",
	"/api/auth/careeros/handoff/redeem",
	"/api/auth/careeros/handoff/issue",
] as const;

export type HandoffAttack = {
	/** One of `HANDOFF_ENDPOINTS`, or a server-only guess. */
	key: string;
	label: string;
	method: "GET" | "POST";
	path: string;
	body?: Record<string, unknown>;
	/** The only acceptable answers: a status, and for a redirect the exact `Location`. */
	expect: { status: number; location?: string };
};

export type HandoffSeed = { orgId: string; orgSlug: string; ownerUserId: string; invitationId: string };

const ISSUE_REFUSAL = "/auth/error?error=handoff_failed";

/** Every attack on the handoff endpoints with Organization A's identifiers, plus the server-only path guesses. */
export function handoffAttacks(seed: HandoffSeed): HandoffAttack[] {
	const identifiers = [seed.orgId, seed.orgSlug, seed.ownerUserId, seed.invitationId];
	const attacks: HandoffAttack[] = [];
	for (const id of identifiers) {
		attacks.push(
			{
				key: "GET /api/careeros/handoff/request/:id",
				label: `request id ${id}`,
				method: "GET",
				path: `/api/careeros/handoff/request/${encodeURIComponent(id)}`,
				expect: { status: 404 },
			},
			{
				key: "GET /api/careeros/handoff/issue",
				label: `issue request ${id}`,
				method: "GET",
				path: `/api/careeros/handoff/issue?request=${encodeURIComponent(id)}`,
				expect: { status: 302, location: ISSUE_REFUSAL },
			},
			{
				key: "POST /api/careeros/handoff/redeem",
				label: `redeem request ${id}`,
				method: "POST",
				path: "/api/careeros/handoff/redeem",
				body: { request: id, token: id },
				expect: { status: 400 },
			},
		);
	}
	attacks.push(
		{
			key: "POST /api/careeros/handoff/begin",
			label: "begin naming A's organization, slug and origin",
			method: "POST",
			path: "/api/careeros/handoff/begin",
			body: {
				provider: "google",
				organizationId: seed.orgId,
				organizationSlug: seed.orgSlug,
				targetOrigin: `https://${seed.orgSlug}.example.test`,
				returnTo: "/dashboard",
			},
			// The platform host is not an organization host, and A's identifiers do not make it one.
			expect: { status: 404 },
		},
		...HANDOFF_SERVER_ONLY_GUESSES.map((path): HandoffAttack => ({
			key: `server-only ${path}`,
			label: `guessed path ${path}`,
			method: "POST",
			path,
			body: { userId: seed.ownerUserId, organizationId: seed.orgId, token: seed.orgId },
			expect: { status: 404 },
		})),
	);
	return attacks;
}

/** Problems with one answer to a handoff attack; an empty array means it was refused as expected. */
export function checkHandoffAnswer(
	attack: HandoffAttack,
	answer: { status: number; location?: string | null | undefined },
): string[] {
	const problems: string[] = [];
	if (answer.status !== attack.expect.status)
		problems.push(`${attack.key} (${attack.label}): expected ${attack.expect.status}, got ${answer.status}`);
	else if (attack.expect.location !== undefined && answer.location !== attack.expect.location)
		problems.push(
			`${attack.key} (${attack.label}): expected a redirect to ${attack.expect.location}, got ${answer.location}`,
		);
	return problems;
}

/** Every handoff endpoint has at least one attack. */
export function checkHandoffInventory(seed: HandoffSeed): string[] {
	const attacked = new Set(handoffAttacks(seed).map((attack) => attack.key));
	return HANDOFF_ENDPOINTS.filter((key) => !attacked.has(key)).map((key) => `${key} has no attack`);
}
