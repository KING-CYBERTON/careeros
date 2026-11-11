import { invoiceDocumentSchema } from "@careeros/invoice";
import z from "zod";
import { isSingleEmailAddress } from "@reactive-resume/utils/brand";

// CAREEROS (P3-T04): the billing procedures for organization owners (admins read only).

export const intervalSchema = z.enum(["month", "year"]);

export const planListingSchema = z.object({
	id: z.string(),
	name: z.string(),
	pricingModel: z
		.enum(["flat", "per_seat"])
		.describe("`flat`: one price per organization. `per_seat`: the price is per seat."),
	seatLimit: z.number().int().nullable().describe("Null means unlimited."),
	priceMonthlyUsdCents: z.number().int().nullable().describe("US cents. Null means contact us."),
	priceAnnualUsdCents: z.number().int().nullable(),
	priceMonthlyKes: z.number().int().nullable().describe("Whole Kenyan shillings."),
	priceAnnualKes: z.number().int().nullable(),
	aiCreditsPerSeat: z.number().int(),
	features: z.record(z.string(), z.boolean()),
	selfService: z.boolean().describe("Whether the organization can buy this plan itself (otherwise: contact us)."),
});

export const billingSchema = z.object({
	planId: z.string(),
	status: z.enum(["trial", "active", "past_due", "suspended"]),
	subscription: z.object({
		status: z.enum(["trialing", "active", "past_due", "canceled", "none"]),
		provider: z.string().describe("`none` when the organization has never paid."),
		seats: z.number().int(),
		interval: intervalSchema.nullable(),
		currentPeriodStart: z.date().nullable(),
		currentPeriodEnd: z.date().nullable(),
		trialEndsAt: z.date().nullable(),
		graceEndsAt: z.date().nullable().describe("When a past-due organization will be suspended."),
	}),
	memberCount: z.number().int(),
	billingEnabled: z.boolean().describe("False when the server has no payment provider: nobody can pay."),
	canManage: z
		.boolean()
		.describe("True for the owner: only the owner starts a trial, checks out, changes seats or cancels."),
	canStartTrial: z.boolean(),
	plans: z.array(planListingSchema),
});

export const checkoutInput = z.object({
	planId: z.enum(["starter", "pro"]).describe("The plan to buy."),
	interval: intervalSchema,
	seats: z.number().int().min(1).max(10_000),
	// CAREEROS (P3-T05): how to pay. Omitted means card.
	method: z
		.enum(["card", "mpesa"])
		.optional()
		.describe("`card` renews by itself; `mpesa` pays one period at a time. Omitted means card."),
});

export const checkoutOutput = z.object({
	redirectUrl: z
		.string()
		.nullable()
		.describe("Send the browser here to pay. Null when a prompt was sent to the phone."),
	stkPushRequested: z.boolean().describe("True when the customer was asked to approve on their phone (M-Pesa)."),
});

export const seatsInput = z.object({ seats: z.number().int().min(1).max(10_000) });

export const acceptedOutput = z.object({
	accepted: z.boolean().describe("The provider was told. The subscription changes when the provider confirms."),
});

export const portalOutput = z.object({ url: z.string() });

export const trialOutput = z.object({ trialEndsAt: z.date() });

// CAREEROS (P3-T06): the payments list behind the billing page (invoices and receipts). Read from the organization's
// audit rows for verified payments, so it holds ids, amounts and periods only, never card data.
export const invoiceSchema = z.object({
	id: z.string(),
	// CAREEROS (P3-T10): `{PREFIX}-{ORG}-{SEQ}`, stable once issued.
	number: z.string().describe("The invoice number, such as INV-7F3K2Q-0003."),
	date: z.date(),
	amount: z.number().int().nullable().describe("In the smallest unit of `currency` (cents for USD and KES)."),
	currency: z.string().nullable(),
	provider: z.string().describe("The payment provider that took the payment, or `manual` for an invoice paid by hand."),
	method: z.enum(["card", "mpesa"]).nullable().describe("How it was paid, when the provider said."),
	reference: z.string().nullable(),
	planId: z.string().nullable(),
	seats: z.number().int().nullable(),
	interval: intervalSchema.nullable(),
	periodStart: z.date().nullable(),
	periodEnd: z.date().nullable(),
});

export const invoicesOutput = z.object({ invoices: z.array(invoiceSchema) });

// CAREEROS (P3-T10): one invoice, the document the web page and the PDF both draw. Money is in minor units.
export const invoiceInput = z.object({ id: z.string().min(1).max(128).describe("The `id` from the invoices list.") });

export const invoiceOutput = invoiceDocumentSchema;

export const invoicePdfOutput = z.object({
	headers: z.object({ "content-disposition": z.string() }),
	body: z.file(),
});

// CAREEROS (P3-T10): the customer details printed on invoices. An empty string clears a field. The database CHECK
// constraints are the last line; these give the caller a clear error first.
// The details go onto a document and into mail headers: no control characters, and no line break except in the address.
// oxlint-disable-next-line no-control-regex -- the point of the check
const CONTROL = /[\u0000-\u001f\u007f]/;
const profileText = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.refine((value) => !CONTROL.test(value), "Use plain text without line breaks.")
		.transform((value) => (value === "" ? null : value));

export const billingProfileSchema = z.object({
	legalName: z.string().nullable().describe("The legal name printed on invoices."),
	address: z.string().nullable().describe("The postal address, one line per line."),
	taxPin: z.string().nullable().describe("The organization's tax PIN (KRA PIN in Kenya)."),
	billingEmail: z.string().nullable().describe("Where invoices are addressed."),
	updatedAt: z.date().nullable().describe("Null until details were first saved."),
});

/** Every field is optional: send only what changes. An empty string clears a field. */
export const billingProfileInput = z.object({
	legalName: profileText(200).optional(),
	address: z
		.string()
		.max(1000)
		.transform((value) =>
			value
				.replaceAll("\r\n", "\n")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.join("\n"),
		)
		.pipe(
			z
				.string()
				.max(500)
				// oxlint-disable-next-line no-control-regex -- the point of the check
				.refine((value) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value), "Remove control characters.")
				.transform((value) => (value === "" ? null : value)),
		)
		.optional(),
	taxPin: profileText(32).optional(),
	billingEmail: profileText(254)
		.refine(
			(value) => value === null || isSingleEmailAddress(value),
			"Use one address like billing@example.com, without a name or angle brackets.",
		)
		.optional(),
});
