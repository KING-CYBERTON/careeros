import z from "zod";
import { protectedProcedure } from "../../context";
import { accountRateLimit } from "../../middleware/rate-limit";
import {
	renderInput,
	renderOutput,
	templateArchiveInput,
	templateArchiveOutput,
	templateCreateInput,
	templateEntrySchema,
	templateUpdateInput,
} from "./schemas";
import {
	archiveMine,
	archiveOrgDefault,
	createMine,
	createOrgDefault,
	listTemplates,
	renderForApplication,
	updateMine,
	updateOrgDefault,
} from "./service";

// CAREEROS (P5-T04): email templates per application stage. Every procedure is a `protectedProcedure`, so it runs in the
// organization of the request; the member is the signed-in user and neither is ever a field. The platform never sends
// these emails: `render` only fills a template in from one of the caller's own applications. The three `org*`
// procedures check on the server that the caller is an owner or admin of an organization that is not a personal
// workspace, and write an audit row with ids and counts only.

const route = { tags: ["Email templates"] };
const notFound = { NOT_FOUND: { status: 404, message: "Not found." } } as const;
const adminErrors = {
	FORBIDDEN: { status: 403, message: "Only an owner or admin of an organization can do this." },
	...notFound,
} as const;

/** Acting user and address, for the audit log. */
const actorOf = (context: { user: { id: string }; trustedClient?: string | undefined }) => ({
	userId: context.user.id,
	ip: context.trustedClient ?? null,
});

export const emailTemplatesRouter = {
	list: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/email-templates",
			operationId: "listEmailTemplates",
			summary: "List the email templates you can use",
			description:
				"Returns your own templates, the defaults of your organization, and a built-in template for every kind your organization has not customised, each with its source. Archived templates are left out. Requires authentication.",
		})
		.input(z.object({}).optional())
		.output(z.array(templateEntrySchema))
		.handler(({ context }) => listTemplates(context.user.id)),

	create: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/email-templates",
			operationId: "createEmailTemplate",
			summary: "Create an email template of your own",
			description:
				"Creates a template only you can see and use: a kind, an optional stage it suggests itself for, a name, a subject and a plain-text body of at most 10 000 characters. Requires authentication.",
		})
		.input(templateCreateInput)
		.use(accountRateLimit)
		.output(templateEntrySchema)
		.handler(({ context, input }) => createMine(context.user.id, input)),

	update: protectedProcedure
		.route({
			...route,
			method: "PATCH",
			path: "/email-templates/{id}",
			operationId: "updateEmailTemplate",
			summary: "Change an email template of your own",
			description: "Changes the fields given of one of your own templates. Requires authentication.",
		})
		.input(templateUpdateInput)
		.use(accountRateLimit)
		.errors(notFound)
		.output(templateEntrySchema)
		.handler(({ context, input }) => updateMine(context.user.id, input)),

	archive: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/email-templates/{id}/archive",
			operationId: "archiveEmailTemplate",
			summary: "Archive an email template of your own",
			description: "Takes one of your own templates out of your list. Requires authentication.",
		})
		.input(templateArchiveInput)
		.use(accountRateLimit)
		.errors(notFound)
		.output(templateArchiveOutput)
		.handler(({ context, input }) => archiveMine(context.user.id, input.id)),

	orgCreate: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/email-templates/org",
			operationId: "createOrganizationEmailTemplate",
			summary: "Create an email template default for the organization",
			description:
				"Creates a default every member of the current organization sees. A default of a kind replaces the built-in template of that kind. Only an owner or admin of an organization can do it. Requires authentication.",
		})
		.input(templateCreateInput)
		.use(accountRateLimit)
		.errors(adminErrors)
		.output(templateEntrySchema)
		.handler(({ context, input }) => createOrgDefault(actorOf(context), input)),

	orgUpdate: protectedProcedure
		.route({
			...route,
			method: "PATCH",
			path: "/email-templates/org/{id}",
			operationId: "updateOrganizationEmailTemplate",
			summary: "Change an email template default of the organization",
			description:
				"Changes the fields given of a default of the current organization. Only an owner or admin can do it. Requires authentication.",
		})
		.input(templateUpdateInput)
		.use(accountRateLimit)
		.errors(adminErrors)
		.output(templateEntrySchema)
		.handler(({ context, input }) => updateOrgDefault(actorOf(context), input)),

	orgArchive: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/email-templates/org/{id}/archive",
			operationId: "archiveOrganizationEmailTemplate",
			summary: "Archive an email template default of the organization",
			description:
				"Archives a default of the current organization, so its members see the built-in template of that kind again. Only an owner or admin can do it. Requires authentication.",
		})
		.input(templateArchiveInput)
		.use(accountRateLimit)
		.errors(adminErrors)
		.output(templateArchiveOutput)
		.handler(({ context, input }) => archiveOrgDefault(actorOf(context), input.id)),

	render: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/email-templates/render",
			operationId: "renderEmailTemplate",
			summary: "Fill an email template in from an application",
			description:
				"Returns the subject, the body and the contact's address for a template filled in from one of your own applications. Unknown variables stay as typed and missing values become a placeholder such as [company]. Nothing is stored or sent. Requires authentication.",
		})
		.input(renderInput)
		.errors({ ...notFound, BAD_REQUEST: { status: 400, message: "Invalid request." } })
		.output(renderOutput)
		.handler(({ context, input }) => renderForApplication(context.user.id, input)),
};
