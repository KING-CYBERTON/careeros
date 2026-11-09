import z from "zod";

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
