import z from "zod";
import { protectedProcedure } from "../../context";
import { accountRateLimit, pdfExportRateLimit } from "../../middleware/rate-limit";
import {
	acceptedOutput,
	billingProfileInput,
	billingProfileSchema,
	billingSchema,
	checkoutInput,
	checkoutOutput,
	invoiceInput,
	invoiceOutput,
	invoicePdfOutput,
	invoicesOutput,
	portalOutput,
	seatsInput,
	trialOutput,
} from "./schemas";
import {
	cancelSubscription,
	changeSeats,
	createCheckout,
	customerPortal,
	getBilling,
	getBillingProfile,
	getInvoice,
	getInvoicePdf,
	listInvoices,
	startTrial,
	updateBillingProfile,
} from "./service";

// CAREEROS (P3-T04): billing for organization owners; owners and admins can read. Write procedures are owner only.
// A suspended organization may still call the five write procedures: they are in SUSPENDED_ORG_ALLOWED_WRITES.

const route = { tags: ["Billing"] };
const ownerOnly = { FORBIDDEN: { status: 403, message: "Only the owner of the organization can do this." } };

export const billingRouter = {
	get: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/billing",
			operationId: "getBilling",
			summary: "Get the organization's plan, subscription and the plans on offer",
			description:
				"Returns the plan, status, seats, billing period, trial and grace dates, provider, and the available plans with their prices. Only an owner or admin can read it. Requires authentication.",
		})
		.input(z.object({}).optional())
		.use(accountRateLimit)
		.errors({ FORBIDDEN: { status: 403, message: "Only an owner or admin of the organization can see billing." } })
		.output(billingSchema)
		.handler(({ context }) => getBilling(context.user.id)),

	// CAREEROS (P3-T06): the payments list for the billing page, owners and admins.
	invoices: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/billing/invoices",
			operationId: "listBillingInvoices",
			summary: "List the organization's payments",
			description:
				"Returns the payments the organization has made (newest first, up to 100): invoice number, date, amount, currency, provider, method, reference and the period each paid for. It holds no card data. Only an owner or admin can read it. Requires authentication.",
		})
		.input(z.object({}).optional())
		.use(accountRateLimit)
		.errors({ FORBIDDEN: { status: 403, message: "Only an owner or admin of the organization can see billing." } })
		.output(invoicesOutput)
		.handler(({ context }) => listInvoices(context.user.id)),

	// CAREEROS (P3-T10): one payment as an invoice, and the same invoice as a PDF file.
	invoice: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/billing/invoices/{id}",
			operationId: "getBillingInvoice",
			summary: "Get one invoice",
			description:
				"Returns one payment as an invoice: the seller and customer details, the invoice number, the line items, the subtotal, tax and total (amounts in the smallest unit of the currency). An id of another organization is not found. Only an owner or admin can read it. Requires authentication.",
		})
		.input(invoiceInput)
		.use(accountRateLimit)
		.errors({
			FORBIDDEN: { status: 403, message: "Only an owner or admin of the organization can see billing." },
			NOT_FOUND: { status: 404, message: "This invoice was not found." },
		})
		.output(invoiceOutput)
		.handler(({ context, input }) => getInvoice(context.user.id, input.id)),

	invoicePdf: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/billing/invoices/{id}/pdf",
			operationId: "downloadBillingInvoice",
			summary: "Download one invoice as a PDF",
			description:
				"Renders the invoice as an A4 PDF, named after the invoice number. An id of another organization is not found. Only an owner or admin can download it. Requires authentication.",
			outputStructure: "detailed",
		})
		.input(invoiceInput)
		.use(pdfExportRateLimit)
		.errors({
			FORBIDDEN: { status: 403, message: "Only an owner or admin of the organization can see billing." },
			NOT_FOUND: { status: 404, message: "This invoice was not found." },
		})
		.output(invoicePdfOutput)
		.handler(async ({ context, input }) => {
			const body = await getInvoicePdf(context.user.id, input.id);
			return { headers: { "content-disposition": `attachment; filename="${body.name}"` }, body };
		}),

	// CAREEROS (P3-T10): the customer details printed on invoices.
	profile: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/billing/profile",
			operationId: "getBillingProfile",
			summary: "Get the billing details printed on invoices",
			description:
				"Returns the legal name, address, tax PIN and billing email the organization prints on its invoices. Only an owner or admin can read it. Requires authentication.",
		})
		.input(z.object({}).optional())
		.use(accountRateLimit)
		.errors({ FORBIDDEN: { status: 403, message: "Only an owner or admin of the organization can see billing." } })
		.output(billingProfileSchema)
		.handler(({ context }) => getBillingProfile(context.user.id)),

	updateProfile: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/billing/profile",
			operationId: "updateBillingProfile",
			summary: "Update the billing details printed on invoices",
			description:
				"Saves the legal name, address, tax PIN and billing email. Send only what changes; an empty string clears a field. The details print on every invoice, earlier ones included. Only the owner can do this. Requires authentication.",
		})
		.input(billingProfileInput)
		.use(accountRateLimit)
		.errors({
			...ownerOnly,
			BAD_REQUEST: { status: 400, message: "The billing details are not valid." },
		})
		.output(billingProfileSchema)
		.handler(({ context, input }) => updateBillingProfile(context.user.id, input)),

	startTrial: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/billing/trial",
			operationId: "startBillingTrial",
			summary: "Start the organization's 14-day trial",
			description:
				"Moves an organization on the personal plan to a 14-day trial with 5 seats. Once per organization. Only the owner can do this. Requires authentication.",
		})
		.input(z.object({}).optional())
		.use(accountRateLimit)
		.errors({
			...ownerOnly,
			CONFLICT: { status: 409, message: "The organization cannot start a trial." },
			PRECONDITION_FAILED: { status: 412, message: "Billing is not enabled on this server." },
		})
		.output(trialOutput)
		.handler(({ context }) => startTrial(context.user.id)),

	checkout: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/billing/checkout",
			operationId: "createBillingCheckout",
			summary: "Start paying for a plan",
			description:
				"Asks the payment provider for a checkout. Seats cannot be fewer than the current members. The subscription changes when the provider confirms the payment. Only the owner can do this. Requires authentication.",
		})
		.input(checkoutInput)
		.use(accountRateLimit)
		.errors({
			...ownerOnly,
			BAD_REQUEST: { status: 400, message: "The plan or seats are not valid." },
			PRECONDITION_FAILED: { status: 412, message: "Billing is not enabled on this server." },
		})
		.output(checkoutOutput)
		.handler(({ context, input }) => createCheckout(context.user.id, input)),

	changeSeats: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/billing/seats",
			operationId: "changeBillingSeats",
			summary: "Change the number of paid seats",
			description:
				"Asks the payment provider to change the seats. Seats cannot be fewer than the current members. The subscription changes when the provider confirms. Only the owner can do this. Requires authentication.",
		})
		.input(seatsInput)
		.use(accountRateLimit)
		.errors({
			...ownerOnly,
			BAD_REQUEST: { status: 400, message: "The seats are not valid." },
			PRECONDITION_FAILED: { status: 412, message: "The organization has no active subscription to change." },
		})
		.output(acceptedOutput)
		.handler(({ context, input }) => changeSeats(context.user.id, input)),

	cancel: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/billing/cancel",
			operationId: "cancelBillingSubscription",
			summary: "Cancel the subscription at the end of the paid period",
			description:
				"Asks the payment provider to cancel. The organization keeps working until the paid period ends. Only the owner can do this. Requires authentication.",
		})
		.input(z.object({}).optional())
		.use(accountRateLimit)
		.errors({
			...ownerOnly,
			PRECONDITION_FAILED: { status: 412, message: "The organization has no active subscription to cancel." },
		})
		.output(acceptedOutput)
		.handler(({ context }) => cancelSubscription(context.user.id)),

	portal: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/billing/portal",
			operationId: "getBillingPortal",
			summary: "Get the payment provider's customer portal",
			description:
				"Returns a link to the provider's page for cards and invoices, when the provider has one. Only the owner can do this. Requires authentication.",
		})
		.input(z.object({}).optional())
		.use(accountRateLimit)
		.errors({
			...ownerOnly,
			PRECONDITION_FAILED: { status: 412, message: "The payment provider has no billing portal." },
		})
		.output(portalOutput)
		.handler(({ context }) => customerPortal(context.user.id)),
};
