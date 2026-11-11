import { describe, expect, it } from "vite-plus/test";
import { buildLines, formatMoney, invoiceDocumentSchema, invoiceNumber, periodText, splitTax } from "./index";
import { base32, sha256 } from "./sha256";

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("sha256 and base32", () => {
	it("matches the published SHA-256 vectors", () => {
		expect(hex(sha256(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(hex(sha256("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(hex(sha256("a".repeat(100)))).toBe("2816597888e4a0d3a36b82b83316ab32680eb8f00f8cd3b904d681246d285a0e");
	});

	it("encodes base32 per RFC 4648", () => {
		const text = new TextEncoder().encode("foobar");
		expect(base32(text, 10)).toBe("MZXW6YTBOI");
		expect(base32(text, 4)).toBe("MZXW");
	});
});

describe("invoiceNumber", () => {
	it("is PREFIX-ORG-SEQ with a six character upper case code and four digit sequence", () => {
		expect(invoiceNumber("INV", "org_123", 3)).toMatch(/^INV-[A-Z2-7]{6}-0003$/);
		expect(invoiceNumber("ACME", "org_123", 12_345)).toMatch(/^ACME-[A-Z2-7]{6}-12345$/);
	});

	it("is stable for an organization and differs between organizations", () => {
		expect(invoiceNumber("INV", "org_a", 1)).toBe(invoiceNumber("INV", "org_a", 1));
		expect(invoiceNumber("INV", "org_a", 1)).not.toBe(invoiceNumber("INV", "org_b", 1));
		const code = (id: string) => invoiceNumber("INV", id, 1).split("-")[1];
		expect(code("org_a")).toBe(code("org_a"));
	});

	it("derives the code from the first 30 bits of the organization's SHA-256", () => {
		expect(base32(sha256("abc"), 6)).toBe("XJ4BNP");
		expect(invoiceNumber("INV", "abc", 1)).toBe("INV-XJ4BNP-0001");
	});
});

describe("splitTax", () => {
	it("returns the whole amount as net at rate 0", () => {
		expect(splitTax(1_200_000, 0)).toEqual({ net: 1_200_000, vat: 0 });
	});

	it("splits a VAT-inclusive 16% amount", () => {
		expect(splitTax(1_200_000, 16)).toEqual({ net: 1_034_483, vat: 165_517 });
	});

	it("always sums exactly, also for odd amounts and fractional rates", () => {
		for (const gross of [0, 1, 7, 99, 101, 12_345, 4_900, 777_701])
			for (const rate of [0, 5, 16, 16.5, 25]) {
				const { net, vat } = splitTax(gross, rate);
				expect(net + vat).toBe(gross);
				expect(Number.isInteger(net) && Number.isInteger(vat)).toBe(true);
				expect(vat).toBeGreaterThanOrEqual(0);
			}
	});
});

describe("buildLines", () => {
	const period = { periodStart: new Date("2026-11-01T00:00:00Z"), periodEnd: new Date("2026-11-30T00:00:00Z") };

	it("gives a flat plan one line of quantity 1", () => {
		expect(
			buildLines({ planName: "Pro", interval: "month", seats: 12, pricingModel: "flat", net: 500_000, ...period }),
		).toEqual([
			{
				description: "Pro plan, monthly",
				detail: "1 Nov 2026 – 30 Nov 2026",
				quantity: 1,
				unitAmount: 500_000,
				amount: 500_000,
			},
		]);
	});

	it("gives a per-seat plan quantity = seats and a unit amount when it divides exactly", () => {
		const [line, ...rest] = buildLines({
			planName: "Pro",
			interval: "year",
			seats: 12,
			pricingModel: "per_seat",
			net: 1_200_000,
			...period,
		});
		expect(rest).toEqual([]);
		expect(line).toMatchObject({
			description: "Pro plan, annual",
			quantity: 12,
			unitAmount: 100_000,
			amount: 1_200_000,
		});
	});

	it("falls back to quantity 1 and names the seats when the amount does not divide", () => {
		const [line] = buildLines({
			planName: "Pro",
			interval: "month",
			seats: 7,
			pricingModel: "per_seat",
			net: 1_000_000,
			...period,
		});
		expect(line).toMatchObject({ quantity: 1, unitAmount: null, amount: 1_000_000 });
		expect(line?.detail).toBe("7 seats, 1 Nov 2026 – 30 Nov 2026");
	});

	it("copes with an unknown period, interval and seat count", () => {
		const [line] = buildLines({
			planName: "Pro",
			interval: null,
			seats: null,
			pricingModel: "per_seat",
			net: 100,
			periodStart: null,
			periodEnd: null,
		});
		expect(line).toEqual({ description: "Pro plan", detail: null, quantity: 1, unitAmount: 100, amount: 100 });
		expect(periodText(null, period.periodEnd)).toBeNull();
	});
});

describe("formatMoney", () => {
	it("prints minor units with two decimals and the currency code", () => {
		expect(formatMoney(1_200_000, "KES", "en-KE")).toMatch(/^KES\s12,000\.00$/);
		expect(formatMoney(4900, "USD", "en-US")).toMatch(/^USD\s49\.00$/);
		expect(formatMoney(0, "KES", "en-US")).toMatch(/0\.00$/);
	});

	it("falls back to the code and amount for a currency or locale the runtime rejects", () => {
		expect(formatMoney(150, "???", "en-US")).toBe("??? 1.50");
	});
});

describe("invoiceDocumentSchema", () => {
	it("accepts a paid document", () => {
		const parsed = invoiceDocumentSchema.safeParse({
			number: "INV-ABCDEF-0001",
			status: "paid",
			issuedAt: new Date(),
			paidAt: new Date(),
			currency: "KES",
			seller: { name: "CareerOS", addressLines: [], email: null, phone: null, taxPin: null, logo: "platform" },
			customer: { name: "Acme", addressLines: ["1 Road"], taxPin: null, email: null },
			payment: { method: "mpesa", reference: "QK7", periodStart: null, periodEnd: null },
			lines: [{ description: "Pro plan", detail: null, quantity: 1, unitAmount: 100, amount: 100 }],
			subtotal: 100,
			tax: null,
			total: 100,
			amountPaid: 100,
			amountDue: 0,
			footer: null,
		});
		expect(parsed.success).toBe(true);
	});
});
