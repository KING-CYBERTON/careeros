import z from "zod";
import { protectedProcedure } from "../../context";
import { accountRateLimit } from "../../middleware/rate-limit";
import { addDomain, getDomainInfo, listDomains, recheckDomain, removeDomain } from "./service";

// CAREEROS (P2-T06): organization custom domains. Owners and admins of the current organization only; the
// organization is the request's, never an input, and a domain id of another organization is NOT_FOUND (row-level security).

const route = { tags: ["Organization"] };
const forbidden = { FORBIDDEN: { status: 403, message: "Only an owner or admin of the organization can do this." } };
const notFound = { NOT_FOUND: { status: 404, message: "No such domain." } };
const notConfigured = {
	PRECONDITION_FAILED: { status: 412, message: "Custom domains for organizations aren't set up on this server." },
};

const domainSchema = z.object({
	id: z.string(),
	hostname: z.string().describe("The domain, as DNS knows it (lower case ASCII)."),
	status: z
		.enum(["pending", "verified", "active", "failed", "removing"])
		.describe(
			"pending: waiting for the TXT record. verified: the TXT record matched and the certificate is being issued. active: the organization is served on this domain. failed: see failureReason. removing: being deleted.",
		),
	records: z
		.array(
			z.object({
				type: z.enum(["TXT", "CNAME"]),
				name: z.string().describe("The record's full host name."),
				value: z.string(),
			}),
		)
		.describe("The DNS records to create: a TXT record that proves ownership and a CNAME to the Cloudflare target."),
	cfSslStatus: z.string().nullable().describe("The certificate's status as the CDN reports it, when it has said."),
	failureReason: z
		.string()
		.nullable()
		.describe("A short code such as verification_timeout, txt_missing or cloudflare_rejected."),
	lastCheckedAt: z.date().nullable(),
	verifiedAt: z.date().nullable(),
	createdAt: z.date(),
});

const idInput = z.object({ id: z.string().min(1).max(100).describe("The domain's id.") });

export const organizationDomainRouter = {
	// CAREEROS (P2-T07): the subdomain address and whether custom domains are set up, for the Domains screen.
	info: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/organization/domains/info",
			operationId: "getOrganizationDomainInfo",
			summary: "Get the organization's address and whether custom domains are available",
			description:
				"Returns the organization's own address on the platform (always works), whether this server can add custom domains at all, and how many an organization may have. Only an owner or admin can do this. Requires authentication.",
		})
		.input(z.object({}).optional())
		.errors(forbidden)
		.output(
			z.object({
				subdomainHost: z.string().nullable().describe("The organization's address, or null when none is configured."),
				subdomainUrl: z.string().nullable(),
				domainsConfigured: z.boolean(),
				domainLimit: z.number().int(),
			}),
		)
		.handler(({ context }) => getDomainInfo(context.user.id)),

	list: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/organization/domains",
			operationId: "listOrganizationDomains",
			summary: "List the organization's custom domains",
			description:
				"Returns the current organization's custom domains with their status and the DNS records each needs. Only an owner or admin can do this. Requires authentication.",
		})
		.input(z.object({}).optional())
		.errors(forbidden)
		.output(z.array(domainSchema))
		.handler(({ context }) => listDomains(context.user.id)),

	add: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/organization/domains",
			operationId: "addOrganizationDomain",
			summary: "Add a custom domain to the organization",
			description:
				"Adds a domain such as careers.example.com and returns the DNS records to create. The domain serves the organization once the TXT record is found and the certificate is issued. At most 5 per organization; a name another organization or account already uses is refused. Only an owner or admin can do this. Requires authentication.",
		})
		.input(z.object({ hostname: z.string().min(1).max(260).describe("A domain such as careers.example.com.") }))
		.use(accountRateLimit)
		.errors({
			...forbidden,
			...notConfigured,
			BAD_REQUEST: { status: 400, message: "That domain can't be used." },
			CONFLICT: { status: 409, message: "That domain isn't available, or the organization has 5 domains." },
		})
		.output(domainSchema)
		.handler(({ context, input }) => addDomain(context.user.id, input.hostname)),

	recheck: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/organization/domains/{id}/recheck",
			operationId: "recheckOrganizationDomain",
			summary: "Check a custom domain now",
			description:
				"Checks the domain's DNS and certificate now instead of waiting for the next scheduled check. At most once a minute per domain. Only an owner or admin can do this. Requires authentication.",
		})
		.input(idInput)
		.use(accountRateLimit)
		.errors({
			...forbidden,
			...notFound,
			...notConfigured,
			CONFLICT: { status: 409, message: "The domain failed or is being removed." },
			TOO_MANY_REQUESTS: { status: 429, message: "This domain was checked a moment ago." },
		})
		.output(domainSchema)
		.handler(({ context, input }) => recheckDomain(context.user.id, input.id)),

	remove: protectedProcedure
		.route({
			...route,
			method: "DELETE",
			path: "/organization/domains/{id}",
			operationId: "removeOrganizationDomain",
			summary: "Remove a custom domain",
			description:
				"Stops the domain serving the organization at once, then deletes it at the CDN. Only an owner or admin can do this. Requires authentication.",
		})
		.input(idInput)
		.use(accountRateLimit)
		.errors({ ...forbidden, ...notFound })
		.output(z.void())
		.handler(({ context, input }) => removeDomain(context.user.id, input.id)),
};
