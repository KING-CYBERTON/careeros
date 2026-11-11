import type { InvoiceDocument } from "@careeros/invoice";
import { execFileSync } from "node:child_process";
import { expect, it } from "vite-plus/test";
import { createInvoicePdfFile } from "./index";

// P3-T10: the rendered invoice PDF, read back as text with Poppler (the same tool the resume export tests use). Fonts are
// downloaded as for resumes, so these tests need the network.

const base: InvoiceDocument = {
	number: "INV-7F3K2Q-0003",
	status: "paid",
	issuedAt: new Date("2026-11-11T09:00:00Z"),
	paidAt: new Date("2026-11-11T09:00:00Z"),
	currency: "KES",
	seller: {
		name: "Example Careers Ltd",
		addressLines: ["P.O. Box 00000", "Nairobi, Kenya"],
		email: "billing@example.test",
		phone: "+254 700 000000",
		taxPin: "P000000000X",
		logo: "platform",
	},
	customer: {
		name: "Acme Careers Ltd",
		addressLines: ["1 Sample Road", "Nairobi"],
		taxPin: "P051234567Z",
		email: "accounts@acme.example.test",
	},
	payment: {
		method: "mpesa",
		reference: "QK7ABC123",
		periodStart: new Date("2026-11-01T00:00:00Z"),
		periodEnd: new Date("2026-11-30T00:00:00Z"),
	},
	lines: [
		{
			description: "Pro plan, monthly",
			detail: "1 Nov 2026 – 30 Nov 2026",
			quantity: 12,
			unitAmount: 100_000,
			amount: 1_200_000,
		},
	],
	subtotal: 1_034_483,
	tax: { label: "VAT", ratePercent: 16, amount: 165_517 },
	total: 1_200_000,
	amountPaid: 1_200_000,
	amountDue: 0,
	footer: "Payable to Example Careers Ltd.",
};

async function render(invoice: InvoiceDocument) {
	const file = await createInvoicePdfFile(invoice, { locale: "en-KE" });
	const bytes = Buffer.from(await file.arrayBuffer());
	const text = execFileSync("pdftotext", ["-enc", "UTF-8", "-layout", "-", "-"], {
		input: bytes,
		encoding: "utf8",
	}).replace(/[ \t]+/g, " ");
	const info = execFileSync("pdfinfo", ["-"], { input: bytes, encoding: "utf8" });
	return { file, bytes, text, info };
}

it(
	"renders an A4 PDF named after the invoice number, with every party and the total",
	{ timeout: 60_000 },
	async () => {
		const { file, bytes, text, info } = await render(base);
		expect(file.type).toBe("application/pdf");
		expect(file.name).toBe("INV-7F3K2Q-0003.pdf");
		expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
		expect(info).toMatch(/Pages:\s+1\b/);
		expect(info).toMatch(/Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
		for (const expected of [
			"INV-7F3K2Q-0003",
			"Example Careers Ltd",
			"Acme Careers Ltd",
			"TAX INVOICE",
			"PAID",
			"Pro plan, monthly",
			"QK7ABC123",
			"P051234567Z",
			"KES 12,000.00",
			"KES 10,344.83",
			"KES 1,655.17",
			"VAT 16%",
			"Amount due",
		])
			expect(text).toContain(expected);
	},
);

it("shows the VAT row only when the rate is above zero", { timeout: 60_000 }, async () => {
	const { text } = await render({ ...base, subtotal: 1_200_000, tax: null });
	expect(text).toContain("INVOICE");
	expect(text).not.toContain("TAX INVOICE");
	expect(text).not.toContain("VAT");
	expect(text).toContain("KES 12,000.00");
});

it("wraps a long customer address and still fits one page", { timeout: 60_000 }, async () => {
	const long =
		"Building with a very long name and an even longer street description, Westlands, Nairobi, Kenya ".repeat(3);
	const { text, info } = await render({
		...base,
		customer: { ...base.customer, addressLines: [long.trim(), "Second line"] },
	});
	expect(info).toMatch(/Pages:\s+1\b/);
	expect(text).toContain("Second line");
	expect(text).toContain("Westlands");
});

it("draws a customer name in another writing system instead of question marks", { timeout: 60_000 }, async () => {
	const { text } = await render({ ...base, customer: { ...base.customer, name: "مرحبا للتوظيف" } });
	expect(text).toContain("مرحبا للتوظيف");
});
