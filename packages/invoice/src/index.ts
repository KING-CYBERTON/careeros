import z from "zod";
import { base32, sha256 } from "./sha256";

// CAREEROS (P3-T10): the invoice as data, and the pure rules that make it: numbering, tax split, line items and money
// formatting. No database, HTTP or DOM, so the API, the web page and the PDF all draw one view model.

const money = z.number().int().min(0);

export const invoiceDocumentSchema = z.object({
	number: z.string(),
	status: z.enum(["paid", "due"]),
	issuedAt: z.date(),
	paidAt: z.date().nullable(),
	currency: z.string().length(3),
	seller: z.object({
		name: z.string(),
		addressLines: z.array(z.string()),
		email: z.string().nullable(),
		phone: z.string().nullable(),
		taxPin: z.string().nullable(),
		logo: z.literal("platform"),
	}),
	customer: z.object({
		name: z.string(),
		addressLines: z.array(z.string()),
		taxPin: z.string().nullable(),
		email: z.string().nullable(),
	}),
	payment: z.object({
		method: z.enum(["card", "mpesa", "invoice"]).nullable(),
		reference: z.string().nullable(),
		periodStart: z.date().nullable(),
		periodEnd: z.date().nullable(),
	}),
	lines: z.array(
		z.object({
			description: z.string(),
			detail: z.string().nullable(),
			quantity: z.number().int().min(1),
			unitAmount: money.nullable(),
			amount: money,
		}),
	),
	subtotal: money,
	tax: z.object({ label: z.string(), ratePercent: z.number().min(0).max(100), amount: money }).nullable(),
	total: money,
	amountPaid: money,
	amountDue: money,
	footer: z.string().nullable(),
});

export type InvoiceDocument = z.infer<typeof invoiceDocumentSchema>;
export type InvoiceLine = InvoiceDocument["lines"][number];

/** `{PREFIX}-{ORG}-{SEQ}`: ORG is the first 6 base32 characters of sha256(organization id), SEQ is 1-based, 4 digits. */
export function invoiceNumber(prefix: string, organizationId: string, sequence: number): string {
	return `${prefix}-${base32(sha256(organizationId), 6)}-${String(sequence).padStart(4, "0")}`;
}

/** VAT-inclusive split: `net = round(gross / (1 + rate))`, `vat = gross - net`, so `net + vat === gross` always. */
export function splitTax(gross: number, ratePercent: number): { net: number; vat: number } {
	if (!(ratePercent > 0)) return { net: gross, vat: 0 };
	// The rate in hundredths of a percent keeps the division in integers for rates such as 16.
	const basis = Math.round(ratePercent * 100);
	const net = Math.round((gross * 10_000) / (10_000 + basis));
	return { net, vat: gross - net };
}

export type BuildLinesInput = {
	planName: string;
	interval: "month" | "year" | null;
	seats: number | null;
	pricingModel: "flat" | "per_seat";
	/** The amount before tax, in minor units. */
	net: number;
	periodStart: Date | null;
	periodEnd: Date | null;
};

/** One date as text, in UTC so the server and every browser print the same day. */
export function formatDay(date: Date, locale: string): string {
	return date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** The period as text, or null when either end is unknown. */
export function periodText(start: Date | null, end: Date | null, locale = "en-GB"): string | null {
	return start && end ? `${formatDay(start, locale)} – ${formatDay(end, locale)}` : null;
}

/**
 * The line items. A per-seat plan is one line with quantity = seats and a unit amount only when it divides exactly;
 * otherwise quantity 1 with "N seats" in the detail and no unit amount. A flat plan is quantity 1.
 */
export function buildLines(input: BuildLinesInput): InvoiceLine[] {
	const cadence = input.interval === "year" ? "annual" : input.interval === "month" ? "monthly" : null;
	const description = cadence ? `${input.planName} plan, ${cadence}` : `${input.planName} plan`;
	const period = periodText(input.periodStart, input.periodEnd);
	const seats = input.seats !== null && input.seats >= 1 ? input.seats : null;
	if (input.pricingModel === "per_seat" && seats !== null) {
		if (input.net % seats === 0)
			return [{ description, detail: period, quantity: seats, unitAmount: input.net / seats, amount: input.net }];
		const seatText = `${seats} seats`;
		return [
			{
				description,
				detail: period ? `${seatText}, ${period}` : seatText,
				quantity: 1,
				unitAmount: null,
				amount: input.net,
			},
		];
	}
	return [{ description, detail: period, quantity: 1, unitAmount: input.net, amount: input.net }];
}

/** An amount in minor units (hundredths, for every currency CareerOS takes) as text, such as `KES 12,000.00`. */
export function formatMoney(minor: number, currency: string, locale: string): string {
	const amount = minor / 100;
	try {
		return new Intl.NumberFormat(locale, {
			style: "currency",
			currency,
			currencyDisplay: "code",
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		})
			.format(amount)
			.replaceAll(" ", " ");
	} catch {
		return `${currency} ${amount.toFixed(2)}`;
	}
}
