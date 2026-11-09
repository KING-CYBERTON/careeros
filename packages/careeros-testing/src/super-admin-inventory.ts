// CAREEROS (P3-Q03): the Super Admin console's procedure inventory and the refusals a caller who is not platform staff
// must always get. Pure data and logic with no application imports, shared by the unit test that compares it with the
// router object, by the HTTP integration suite in apps/server, by the cross-org fuzz and by the e2e security spec, so a
// procedure added to `admin.*` fails every one of them until its row is added here (and so its refusals are decided).

/** The rows a request can name, created by each suite for itself. */
export type SuperAdminSeed = {
	/** An organization the platform admin may act on. */
	orgId: string;
	/** A member of that organization (not a platform admin). */
	userId: string;
	/** An announcement that exists. */
	announcementId: string;
	/** A plan id that exists. */
	planId: string;
	/** A unique string for fields that must not repeat (a payment reference). */
	unique: string;
};

export type SuperAdminProcedure = {
	/** The router path, as `Object.keys` of the router object nest it. */
	path: string;
	/** `read` procedures change nothing but their audit row; `write` procedures change platform data. */
	effect: "read" | "write";
	/** A valid input, so a refusal is the gate's answer and never the validator's. */
	input: (seed: SuperAdminSeed) => unknown;
};

const HOUR = 3_600_000;

/**
 * Every procedure of the `admin` router. The unit test in apps/server fails when the router has a procedure this list
 * lacks or this list has one the router lacks.
 */
export const SUPER_ADMIN_PROCEDURES: readonly SuperAdminProcedure[] = [
	{ path: "admin.plans", effect: "read", input: () => ({}) },
	{ path: "admin.orgs.list", effect: "read", input: () => ({}) },
	{ path: "admin.orgs.get", effect: "read", input: (s) => ({ organizationId: s.orgId }) },
	{
		path: "admin.orgs.setStatus",
		effect: "write",
		input: (s) => ({ organizationId: s.orgId, status: "suspended", reason: "security test: suspend" }),
	},
	{
		path: "admin.orgs.setPlan",
		effect: "write",
		input: (s) => ({ organizationId: s.orgId, planId: s.planId, seats: null, reason: "security test: plan" }),
	},
	{
		path: "admin.orgs.setAiOverage",
		effect: "write",
		input: (s) => ({ organizationId: s.orgId, allowed: true, reason: "security test: overage" }),
	},
	{
		path: "admin.payments.record",
		effect: "write",
		input: (s) => ({
			orgId: s.orgId,
			planId: s.planId,
			seats: 3,
			interval: "month",
			periodStart: new Date(Date.UTC(2026, 10, 1)).toISOString(),
			periodEnd: new Date(Date.UTC(2026, 11, 1)).toISOString(),
			amount: 4900,
			currency: "USD",
			reference: `security-${s.unique}`,
		}),
	},
	{ path: "admin.metrics", effect: "read", input: () => ({}) },
	{ path: "admin.audit.list", effect: "read", input: () => ({}) },
	{ path: "admin.announcements.list", effect: "read", input: () => ({}) },
	{
		path: "admin.announcements.save",
		effect: "write",
		input: (s) => ({
			title: `Security test ${s.unique}`,
			body: "Plain text.",
			severity: "info",
			startsAt: new Date(Date.now() - HOUR).toISOString(),
			endsAt: new Date(Date.now() + HOUR).toISOString(),
		}),
	},
	{ path: "admin.announcements.end", effect: "write", input: (s) => ({ id: s.announcementId }) },
	// CAREEROS (P6-T02): mails the signed-in admin themself; sends mail and writes one `email.test_sent` platform audit row.
	{ path: "admin.email.sendTest", effect: "write", input: () => ({}) },
	{
		path: "admin.impersonation.start",
		effect: "write",
		input: (s) => ({ organizationId: s.orgId, userId: s.userId, reason: "security test: support" }),
	},
];

/** The HTTP path of a procedure on the RPC adapter. */
export const rpcPath = (procedure: string) => `/api/rpc/${procedure.split(".").join("/")}`;

/** The oRPC code a refused call carries, with its HTTP status. */
export type Refusal = { status: number; code: "UNAUTHORIZED" | "NOT_FOUND" | "FORBIDDEN"; dataCode?: string };

/** The callers a Super Admin procedure refuses (on the platform host unless stated). */
export const NON_STAFF_CALLERS = [
	"anonymous",
	"member",
	"org admin",
	"org owner",
	"banned platform admin",
	"platform admin without 2FA",
	"clipper token",
	"API key",
] as const;
export type NonStaffCaller = (typeof NON_STAFF_CALLERS)[number];

/**
 * What each refused caller is told, so the answer is exact and a change of it is a decision:
 *   - no sign-in, a banned account and a clipper token (it exists on organization hosts only) are 401;
 *   - an account that is not platform staff, and any API key, get 404 as if the route did not exist;
 *   - a platform admin without 2FA is told why (403, TWO_FACTOR_REQUIRED).
 */
export const EXPECTED_REFUSAL: Record<NonStaffCaller, Refusal> = {
	anonymous: { status: 401, code: "UNAUTHORIZED" },
	member: { status: 404, code: "NOT_FOUND" },
	"org admin": { status: 404, code: "NOT_FOUND" },
	"org owner": { status: 404, code: "NOT_FOUND" },
	"banned platform admin": { status: 401, code: "UNAUTHORIZED" },
	"platform admin without 2FA": { status: 403, code: "FORBIDDEN", dataCode: "TWO_FACTOR_REQUIRED" },
	"clipper token": { status: 401, code: "UNAUTHORIZED" },
	"API key": { status: 404, code: "NOT_FOUND" },
};

/** What a real platform admin is told on an organization host or a custom domain: the console does not exist there. */
export const EXPECTED_OFF_PLATFORM_REFUSAL: Refusal = { status: 404, code: "NOT_FOUND" };

/** What a clipper token is told on an organization host: it reaches only its allow-list. */
export const EXPECTED_CLIPPER_ON_ORG_HOST: Refusal = { status: 403, code: "FORBIDDEN", dataCode: "CLIPPER_SCOPE" };

/** Compares the router's `admin.*` procedure paths with the inventory. */
export function diffInventory(
	routerPaths: readonly string[],
	inventory: readonly SuperAdminProcedure[] = SUPER_ADMIN_PROCEDURES,
): { missingFromInventory: string[]; staleInInventory: string[] } {
	const listed = new Set(inventory.map((entry) => entry.path));
	const found = new Set(routerPaths);
	return {
		missingFromInventory: [...found].filter((path) => !listed.has(path)).sort(),
		staleInInventory: [...listed].filter((path) => !found.has(path)).sort(),
	};
}
