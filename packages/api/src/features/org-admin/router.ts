import z from "zod";
import { protectedProcedure } from "../../context";
import { accountRateLimit } from "../../middleware/rate-limit";
import { exportAnalyticsMembers, exportAnalyticsSummary, getAnalyticsMembers, getAnalyticsSummary } from "./analytics";
import { orgBulkInviteRateLimit } from "./rate-limit";
import {
	analyticsInput,
	analyticsMembersInput,
	analyticsMembersSchema,
	analyticsSummarySchema,
	bulkInviteInput,
	bulkInviteResultSchema,
	cohortArchiveInput,
	cohortCreateInput,
	cohortListInput,
	cohortSchema,
	cohortUpdateInput,
	exportInput,
	exportOutput,
	memberListInput,
	memberListSchema,
	setCohortInput,
	setCohortOutput,
} from "./schemas";
import {
	archiveCohort,
	createCohort,
	listCohorts,
	listMembers,
	previewBulkInvites,
	sendBulkInvites,
	setMemberCohort,
	updateCohort,
} from "./service";

// CAREEROS (P3-T08, phase plan D8): the Org Admin console API. Every procedure is a `protectedProcedure` in the current
// organization and checks on the server that the caller is an owner or admin of an organization that is not a personal
// workspace (`requireOrgAdmin`). Writes are refused for a suspended organization by `protectedProcedure` itself; they
// are deliberately not on the suspended allow-list. Exports are GETs, so a suspended organization can still export.

const route = { tags: ["Organization admin"] };
const adminErrors = {
	FORBIDDEN: { status: 403, message: "Only an owner or admin of an organization can do this." },
	NOT_FOUND: { status: 404, message: "Not found." },
} as const;

/** Acting user and address, for the audit log. */
const actorOf = (context: { user: { id: string }; trustedClient?: string | undefined }) => ({
	userId: context.user.id,
	ip: context.trustedClient ?? null,
});

export const orgAdminRouter = {
	cohorts: {
		list: protectedProcedure
			.route({
				...route,
				method: "GET",
				path: "/org-admin/cohorts",
				operationId: "listOrganizationCohorts",
				summary: "List the organization's cohorts",
				description:
					"Returns the cohorts of the current organization with their member counts. Archived cohorts are left out unless includeArchived is true. Only an owner or admin of an organization (not a personal workspace) can read it. Requires authentication.",
			})
			.input(cohortListInput.optional())
			.errors(adminErrors)
			.output(z.array(cohortSchema))
			.handler(({ context, input }) => listCohorts(context.user.id, input ?? {})),

		create: protectedProcedure
			.route({
				...route,
				method: "POST",
				path: "/org-admin/cohorts",
				operationId: "createOrganizationCohort",
				summary: "Create a cohort",
				description:
					"Creates a cohort in the current organization: a name (unique in the organization, at most 100 characters), an optional description and optional start and end dates. Only an owner or admin can do it. Requires authentication.",
			})
			.input(cohortCreateInput)
			.use(accountRateLimit)
			.errors({ ...adminErrors, CONFLICT: { status: 409, message: "A cohort with this name already exists." } })
			.output(cohortSchema)
			.handler(({ context, input }) => createCohort(actorOf(context), input)),

		update: protectedProcedure
			.route({
				...route,
				method: "PATCH",
				path: "/org-admin/cohorts/{id}",
				operationId: "updateOrganizationCohort",
				summary: "Update a cohort",
				description:
					"Changes the name, description or dates of a cohort of the current organization. Only an owner or admin can do it. Requires authentication.",
			})
			.input(cohortUpdateInput)
			.use(accountRateLimit)
			.errors({ ...adminErrors, CONFLICT: { status: 409, message: "A cohort with this name already exists." } })
			.output(cohortSchema)
			.handler(({ context, input }) => updateCohort(actorOf(context), input)),

		archive: protectedProcedure
			.route({
				...route,
				method: "POST",
				path: "/org-admin/cohorts/{id}/archive",
				operationId: "archiveOrganizationCohort",
				summary: "Archive or restore a cohort",
				description:
					"Archives a cohort of the current organization, or brings it back with archived set to false. An archived cohort keeps its members but cannot be chosen for new ones. Only an owner or admin can do it. Requires authentication.",
			})
			.input(cohortArchiveInput)
			.use(accountRateLimit)
			.errors(adminErrors)
			.output(cohortSchema)
			.handler(({ context, input }) => archiveCohort(actorOf(context), input)),
	},

	members: {
		list: protectedProcedure
			.route({
				...route,
				method: "GET",
				path: "/org-admin/members",
				operationId: "listOrganizationMembersWithCohorts",
				summary: "List members with their cohort",
				description:
					"Returns the members of the current organization with their role and cohort, 50 per page, sorted by name. Only an owner or admin can read it. Requires authentication.",
			})
			.input(memberListInput.optional())
			.errors(adminErrors)
			.output(memberListSchema)
			.handler(({ context, input }) => listMembers(context.user.id, input ?? {})),

		setCohort: protectedProcedure
			.route({
				...route,
				method: "POST",
				path: "/org-admin/members/cohort",
				operationId: "setOrganizationMembersCohort",
				summary: "Move members to a cohort",
				description:
					"Moves up to 500 members of the current organization into a cohort, or out of theirs with a null cohortId. Ids that are not members of this organization are skipped. Only an owner or admin can do it. Requires authentication.",
			})
			.input(setCohortInput)
			.use(accountRateLimit)
			.errors(adminErrors)
			.output(setCohortOutput)
			.handler(({ context, input }) => setMemberCohort(actorOf(context), input)),
	},

	invitations: {
		dryRun: protectedProcedure
			.route({
				...route,
				method: "POST",
				path: "/org-admin/invitations/dry-run",
				operationId: "previewBulkInvitations",
				summary: "Check a CSV of invitations",
				description:
					"Reads a UTF-8 CSV (header row; email, and optionally role member or admin and a cohort name; at most 500 rows and 256 KB) and reports, per row, whether it would be invited, without sending anything. Statuses: ok, duplicate_in_file, already_member, already_invited, invalid_email, invalid_role, unknown_cohort, over_seat_limit. Only an owner or admin can do it. Requires authentication.",
			})
			.input(bulkInviteInput)
			.use(accountRateLimit)
			.errors({
				...adminErrors,
				BAD_REQUEST: { status: 400, message: "The file cannot be read as an invitation list." },
			})
			.output(bulkInviteResultSchema)
			.handler(async ({ context, input }) =>
				previewBulkInvites(context.user.id, new Uint8Array(await input.file.arrayBuffer())),
			),

		confirm: protectedProcedure
			.route({
				...route,
				method: "POST",
				path: "/org-admin/invitations/bulk",
				operationId: "sendBulkInvitations",
				summary: "Send the invitations of a CSV",
				description:
					"Reads the same CSV again and sends an invitation for every row that is ok, one at a time, through the same seat checks as a single invitation. A row the seat limit refuses is reported as over_seat_limit and not sent. Needs a signed-in browser session. Rate limited per organization. Only an owner or admin can do it. Requires authentication.",
			})
			.input(bulkInviteInput)
			.use(accountRateLimit)
			.use(orgBulkInviteRateLimit)
			.errors({
				...adminErrors,
				BAD_REQUEST: { status: 400, message: "The file cannot be read as an invitation list." },
			})
			.output(bulkInviteResultSchema)
			.handler(async ({ context, input }) =>
				sendBulkInvites({
					actor: actorOf(context),
					headers: context.reqHeaders,
					bytes: new Uint8Array(await input.file.arrayBuffer()),
				}),
			),
	},

	analytics: {
		summary: protectedProcedure
			.route({
				...route,
				method: "GET",
				path: "/org-admin/analytics",
				operationId: "getOrganizationAnalytics",
				summary: "Get the organization's analytics",
				description:
					"Counts for a date range (default the last 30 days, at most 366) and an optional cohort: active members, resumes created, applications created and by stage, interviews and offers, and AI credits used. Only an owner or admin can read it. Requires authentication.",
			})
			.input(analyticsInput.optional())
			.errors(adminErrors)
			.output(analyticsSummarySchema)
			.handler(({ context, input }) => getAnalyticsSummary(context.user.id, input ?? {})),

		members: protectedProcedure
			.route({
				...route,
				method: "GET",
				path: "/org-admin/analytics/members",
				operationId: "listOrganizationAnalyticsMembers",
				summary: "List members with their activity",
				description:
					"One page (50) of the members of the current organization with their cohort, last activity and counts of resumes, applications, interviews and offers for the range. Sortable. Only an owner or admin can read it. Requires authentication.",
			})
			.input(analyticsMembersInput.optional())
			.errors(adminErrors)
			.output(analyticsMembersSchema)
			.handler(({ context, input }) => getAnalyticsMembers(context.user.id, input ?? {})),

		exportMembers: protectedProcedure
			.route({
				...route,
				method: "GET",
				path: "/org-admin/analytics/members/export",
				operationId: "exportOrganizationAnalyticsMembers",
				summary: "Export the members table as CSV",
				description:
					"Returns every row of the analytics members table for the filters as a CSV download. Cells that begin with = + - @ a tab or a carriage return are written as text. Each export is recorded in the audit log. Only an owner or admin can do it. Requires authentication.",
				successDescription: "The CSV file.",
				outputStructure: "detailed",
			})
			.input(exportInput.optional())
			.use(accountRateLimit)
			.errors(adminErrors)
			.output(exportOutput)
			.handler(({ context, input }) => exportAnalyticsMembers(actorOf(context), input ?? {})),

		exportSummary: protectedProcedure
			.route({
				...route,
				method: "GET",
				path: "/org-admin/analytics/export",
				operationId: "exportOrganizationAnalyticsSummary",
				summary: "Export the analytics summary as CSV",
				description:
					"Returns the analytics summary for the filters as a metric,value CSV download. Each export is recorded in the audit log. Only an owner or admin can do it. Requires authentication.",
				successDescription: "The CSV file.",
				outputStructure: "detailed",
			})
			.input(exportInput.optional())
			.use(accountRateLimit)
			.errors(adminErrors)
			.output(exportOutput)
			.handler(({ context, input }) => exportAnalyticsSummary(actorOf(context), input ?? {})),
	},
};
