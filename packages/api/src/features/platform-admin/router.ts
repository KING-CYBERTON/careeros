import { listActivePlans } from "@careeros/billing";
import {
	activeAnnouncementsForMember,
	AdminError,
	assertPlatformAdmin,
	dismissAnnouncement,
	endAnnouncement,
	endImpersonation,
	getImpersonationForSession,
	getMetrics,
	getOrg,
	listAnnouncements,
	listAudit,
	listOrgs,
	recordManualPayment,
	saveAnnouncement,
	setAiOverage,
	setOrgPlan,
	setOrgStatus,
	startImpersonation,
} from "@careeros/platform-admin";
import { currentHost } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import z from "zod";
import { orgSubdomainOrigin } from "@reactive-resume/auth/email-brand";
import { protectedProcedure, protectedProcedureWithoutOrg } from "../../context";
import { accountRateLimit } from "../../middleware/rate-limit";
import { sendTestEmailToAdmin } from "./email-test";

// CAREEROS (P3-T07, phase plan D6, D7): the Super Admin console's procedures and the two member-facing pieces (the
// announcement banner and the support-session banner). Every admin procedure:
//   * answers 404 on any organization host, custom domain or unknown host, decided here from the resolved host;
//   * needs a browser session (an API key or bearer token never reaches the console);
//   * passes the signed-in user's id to a SECURITY DEFINER function that checks, in the database, that the user is a
//     non-banned platform admin with two-factor authentication on, and writes its audit row in the same transaction.
// The procedures are `Internal` (not in the public OpenAPI document or MCP) and are refused in a support session
// (their path starts with `admin.`, see IMPERSONATION_REFUSED_PREFIXES).

const route = { tags: ["Internal"] };

/** Maps a refusal of the database functions to what the client sees. A non-admin gets 404, like any unknown route. */
function toORPCError(error: unknown): unknown {
	if (!(error instanceof AdminError)) return error;
	switch (error.code) {
		case "not_admin":
			return new ORPCError("NOT_FOUND", { message: "Not found" });
		case "two_factor_required":
			return new ORPCError("FORBIDDEN", {
				message: "Turn on two-factor authentication to use the console.",
				data: { code: "TWO_FACTOR_REQUIRED" },
			});
		case "cannot_impersonate_admin":
			return new ORPCError("FORBIDDEN", { message: error.message, data: { code: "CANNOT_IMPERSONATE_ADMIN" } });
		case "not_found":
			return new ORPCError("NOT_FOUND", { message: error.message });
		case "invalid":
			return new ORPCError("BAD_REQUEST", { message: error.message });
	}
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toORPCError(error);
	}
}

const adminProcedure = protectedProcedureWithoutOrg.use(({ context, next }) => {
	const host = context.host ?? currentHost();
	// No host means the platform host; every other kind (organization, custom domain, unknown) does not have a console.
	if (host && host.kind !== "platform") throw new ORPCError("NOT_FOUND", { message: "Not found" });
	if (context.authentication?.method !== "session") throw new ORPCError("NOT_FOUND", { message: "Not found" });
	return next({ context: { ...context, actorId: context.user.id } });
});

const reason = z.string().trim().min(10).max(500);
const id = z.string().min(1).max(128);
const isoDate = z.coerce.date();

const listOrgsInput = z.object({
	search: z.string().trim().max(120).optional(),
	status: z.enum(["active", "suspended"]).optional(),
	planId: z.string().max(64).optional(),
	limit: z.number().int().min(1).max(100).optional(),
	offset: z.number().int().min(0).max(100_000).optional(),
});

const auditInput = z.object({
	organizationId: id.optional(),
	platformOnly: z.boolean().optional(),
	action: z.string().max(120).optional(),
	from: isoDate.optional(),
	to: isoDate.optional(),
	before: id.optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

const announcementInput = z.object({
	id: id.optional(),
	title: z.string().trim().min(1).max(120),
	body: z.string().trim().min(1).max(1000),
	severity: z.enum(["info", "warning"]),
	startsAt: isoDate,
	endsAt: isoDate,
	planId: z.string().max(64).nullable().optional(),
	organizationId: id.nullable().optional(),
});

const paymentInput = z.object({
	orgId: id,
	planId: z.string().min(1).max(64),
	seats: z.number().int().min(1).max(100_000),
	interval: z.enum(["month", "year"]),
	periodStart: isoDate,
	periodEnd: isoDate,
	amount: z.number().int().min(1).max(10_000_000_000),
	currency: z.string().regex(/^[A-Z]{3}$/),
	reference: z.string().trim().min(1).max(128),
});

export const adminRouter = {
	plans: adminProcedure
		.route({ ...route, method: "GET", operationId: "adminListPlans", summary: "List the plans an admin can assign" })
		.input(z.object({}).optional())
		.handler(({ context }) =>
			run(async () => {
				// The plan table is global; the actor is still checked in the database first.
				await assertPlatformAdmin(context.actorId);
				return (await listActivePlans()).map((plan) => ({ id: plan.id, name: plan.name }));
			}),
		),

	orgs: {
		list: adminProcedure
			.route({ ...route, method: "GET", operationId: "adminListOrganizations", summary: "List organizations" })
			.input(listOrgsInput.optional())
			.handler(({ context, input }) => run(() => listOrgs(context.actorId, input ?? {}))),

		get: adminProcedure
			.route({ ...route, method: "GET", operationId: "adminGetOrganization", summary: "One organization in full" })
			.input(z.object({ organizationId: id }))
			.handler(({ context, input }) => run(() => getOrg(context.actorId, input.organizationId))),

		setStatus: adminProcedure
			.route({ ...route, method: "POST", operationId: "adminSetOrganizationStatus", summary: "Suspend or reactivate" })
			.input(z.object({ organizationId: id, status: z.enum(["suspended", "active"]), reason }))
			.handler(({ context, input }) =>
				run(() => setOrgStatus(context.actorId, input.organizationId, input.status, input.reason)),
			),

		setPlan: adminProcedure
			.route({ ...route, method: "POST", operationId: "adminSetOrganizationPlan", summary: "Assign a plan" })
			.input(
				z.object({
					organizationId: id,
					planId: z.string().min(1).max(64),
					seats: z.number().int().min(1).max(100_000).nullable(),
					reason,
				}),
			)
			.handler(({ context, input }) =>
				run(() => setOrgPlan(context.actorId, input.organizationId, input.planId, input.seats, input.reason)),
			),

		setAiOverage: adminProcedure
			.route({ ...route, method: "POST", operationId: "adminSetAiOverage", summary: "Allow or stop AI overage" })
			.input(z.object({ organizationId: id, allowed: z.boolean(), reason }))
			.handler(({ context, input }) =>
				run(() => setAiOverage(context.actorId, input.organizationId, input.allowed, input.reason)),
			),
	},

	payments: {
		record: adminProcedure
			.route({ ...route, method: "POST", operationId: "adminRecordPayment", summary: "Record a manual payment" })
			.input(paymentInput)
			.handler(({ context, input }) => run(() => recordManualPayment(context.actorId, input))),
	},

	metrics: adminProcedure
		.route({ ...route, method: "GET", operationId: "adminMetrics", summary: "Platform metrics" })
		.input(z.object({ from: isoDate.optional(), to: isoDate.optional() }).optional())
		.handler(({ context, input }) => run(() => getMetrics(context.actorId, input ?? {}))),

	audit: {
		list: adminProcedure
			.route({ ...route, method: "GET", operationId: "adminListAudit", summary: "The audit log of every organization" })
			.input(auditInput.optional())
			.handler(({ context, input }) => run(() => listAudit(context.actorId, input ?? {}))),
	},

	announcements: {
		list: adminProcedure
			.route({ ...route, method: "GET", operationId: "adminListAnnouncements", summary: "List announcements" })
			.input(z.object({}).optional())
			.handler(({ context }) => run(() => listAnnouncements(context.actorId))),

		save: adminProcedure
			.route({ ...route, method: "POST", operationId: "adminSaveAnnouncement", summary: "Create or update" })
			.input(announcementInput)
			.handler(({ context, input }) => run(() => saveAnnouncement(context.actorId, input))),

		end: adminProcedure
			.route({ ...route, method: "POST", operationId: "adminEndAnnouncement", summary: "End an announcement now" })
			.input(z.object({ id }))
			.handler(({ context, input }) => run(() => endAnnouncement(context.actorId, input.id))),
	},

	// CAREEROS (P6-T02): mails the signed-in admin themself with a fixed template and returns the provider's answer. No
	// recipient input. The platform-admin check runs in the database first, then the send, then a non-`admin.*` audit row.
	email: {
		sendTest: adminProcedure
			.route({ ...route, method: "POST", operationId: "adminSendTestEmail", summary: "Send a test email to yourself" })
			.input(z.object({}).optional())
			.use(accountRateLimit)
			.handler(({ context }) =>
				run(async () => {
					await assertPlatformAdmin(context.actorId);
					return sendTestEmailToAdmin(context.actorId, context.user.email);
				}),
			),
	},

	impersonation: {
		start: adminProcedure
			.route({ ...route, method: "POST", operationId: "adminStartImpersonation", summary: "Start a support session" })
			.input(z.object({ organizationId: id, userId: id, reason }))
			.use(accountRateLimit)
			.errors({
				PRECONDITION_FAILED: { status: 412, message: "Organization hosts are not enabled on this server." },
			})
			.handler(({ context, input, errors }) =>
				run(async () => {
					// The slug names the member's organization host. getOrg also checks the actor and audits the view.
					const org = await getOrg(context.actorId, input.organizationId);
					const origin = orgSubdomainOrigin(org.organization.slug);
					if (!origin) throw errors.PRECONDITION_FAILED();
					const started = await startImpersonation(context.actorId, {
						targetUserId: input.userId,
						organizationId: input.organizationId,
						reason: input.reason,
						targetOrigin: origin,
					});
					// The token travels in the URL fragment: a fragment never reaches a server log, a proxy or a Referer.
					const fragment = new URLSearchParams({ id: started.id, token: started.token });
					return {
						url: `${origin}/auth/impersonate#${fragment.toString()}`,
						expiresAt: started.expiresAt,
					};
				}),
			),
	},
};

const memberRoute = { tags: ["Internal"] };

/** The member-facing announcement banner. Reads and dismissals are for the signed-in user in the host's organization. */
export const announcementsRouter = {
	active: protectedProcedure
		.route({
			...memberRoute,
			method: "GET",
			operationId: "listActiveAnnouncements",
			summary: "Announcements that apply to the member",
		})
		.input(z.object({}).optional())
		.handler(({ context }) =>
			context.organizationId ? activeAnnouncementsForMember(context.user.id, context.organizationId) : [],
		),

	dismiss: protectedProcedure
		.route({
			...memberRoute,
			method: "POST",
			operationId: "dismissAnnouncement",
			summary: "Dismiss an announcement for the signed-in member",
		})
		.input(z.object({ id }))
		.handler(async ({ context, input }) => ({ dismissed: await dismissAnnouncement(context.user.id, input.id) })),
};

/** The support-session banner (the member sees it) and the member's "End now". */
export const impersonationRouter = {
	current: protectedProcedure
		.route({
			...memberRoute,
			method: "GET",
			operationId: "getCurrentSupportSession",
			summary: "The support session this browser session is, if any",
		})
		.input(z.object({}).optional())
		.handler(({ context }) =>
			context.authentication?.sessionId && context.authentication.impersonatedBy
				? getImpersonationForSession(context.authentication.sessionId, context.user.id)
				: null,
		),

	end: protectedProcedure
		.route({
			...memberRoute,
			method: "POST",
			operationId: "endSupportSession",
			summary: "End the support session now",
		})
		.input(z.object({}).optional())
		.handler(async ({ context }) => ({
			ended:
				context.authentication?.sessionId && context.authentication.impersonatedBy
					? await endImpersonation(context.authentication.sessionId, context.user.id)
					: false,
		})),
};
