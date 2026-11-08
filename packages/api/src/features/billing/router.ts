import z from "zod";
import { protectedProcedure } from "../../context";
import { accountRateLimit } from "../../middleware/rate-limit";
import {
	acceptedOutput,
	billingSchema,
	checkoutInput,
	checkoutOutput,
	portalOutput,
	seatsInput,
	trialOutput,
} from "./schemas";
import { cancelSubscription, changeSeats, createCheckout, customerPortal, getBilling, startTrial } from "./service";

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
