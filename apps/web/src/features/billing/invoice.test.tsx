// @vitest-environment happy-dom

import type { InvoiceDocument } from "@careeros/invoice";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

// CAREEROS (P3-T10): the invoice sheet (number, Paid badge, lines, totals, VAT row only above rate 0) and the invoice
// page (Download invoice calls the PDF procedure and saves `<number>.pdf`, a failure shows a toast, Print prints).

const state = vi.hoisted(() => ({
	invoice: undefined as unknown,
	invoiceError: null as unknown,
	pdf: vi.fn(),
	download: vi.fn(),
	toast: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: object) => ({ options }),
	Link: ({ children }: { children: React.ReactNode }) => <a href="/x">{children}</a>,
}));
vi.mock("@reactive-resume/utils/file", () => ({ downloadWithAnchor: state.download }));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: state.toast } }));
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		billing: {
			invoice: {
				queryOptions: () => ({
					queryKey: ["billing", "invoice"],
					queryFn: async () => {
						if (state.invoiceError) throw state.invoiceError;
						return state.invoice;
					},
				}),
			},
			invoicePdf: { mutationOptions: (options: object) => ({ ...options, mutationFn: state.pdf }) },
		},
	},
}));

i18n.loadAndActivate({ locale: "en", messages: {} });

const { InvoiceSheet } = await import("./invoice-sheet");
const { ReceiptPage } = await import("./receipt-page");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const wrap = (ui: React.ReactNode) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		<I18nProvider i18n={i18n}>{ui}</I18nProvider>
	</QueryClientProvider>
);

const make = (over: Partial<InvoiceDocument> = {}): InvoiceDocument => ({
	number: "INV-7F3K2Q-0003",
	status: "paid",
	issuedAt: new Date("2026-11-11T09:00:00Z"),
	paidAt: new Date("2026-11-11T09:00:00Z"),
	currency: "KES",
	seller: {
		name: "Example Careers Ltd",
		addressLines: ["P.O. Box 00000", "Nairobi, Kenya"],
		email: "billing@example.test",
		phone: null,
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
	...over,
});

beforeEach(() => {
	state.invoice = make();
	state.invoiceError = null;
	state.pdf.mockReset();
	state.download.mockReset();
	state.toast.mockReset();
});
afterEach(cleanup);

it("renders the number, the Paid badge, the parties, the lines and the totals", () => {
	render(wrap(<InvoiceSheet invoice={make()} locale="en-KE" />));
	expect(screen.getByTestId("invoice-title").textContent).toBe("TAX INVOICE");
	expect(screen.getByTestId("invoice-number").textContent).toBe("No. INV-7F3K2Q-0003");
	expect(screen.getByTestId("invoice-status").textContent).toBe("PAID");
	const sheet = screen.getByTestId("invoice-sheet");
	expect(sheet.textContent).toContain("Example Careers Ltd");
	expect(sheet.textContent).toContain("PIN P000000000X");
	expect(screen.getByTestId("invoice-customer").textContent).toContain("Acme Careers Ltd");
	expect(screen.getByTestId("invoice-customer").textContent).toContain("KRA PIN P051234567Z");
	expect(sheet.textContent).toContain("M-Pesa");
	expect(sheet.textContent).toContain("QK7ABC123");
	const line = screen.getByTestId("invoice-line");
	expect(line.textContent).toContain("Pro plan, monthly");
	expect(line.textContent).toMatch(/KES\s1,000\.00/);
	expect(line.textContent).toMatch(/KES\s12,000\.00/);
	expect(screen.getByTestId("invoice-subtotal").textContent).toMatch(/KES\s10,344\.83/);
	expect(screen.getByTestId("invoice-tax").textContent).toMatch(/VAT 16%.*KES\s1,655\.17/);
	expect(screen.getByTestId("invoice-total").textContent).toMatch(/KES\s12,000\.00/);
	expect(screen.getByTestId("invoice-paid-amount").textContent).toMatch(/KES\s12,000\.00/);
	expect(screen.getByTestId("invoice-due").textContent).toMatch(/KES\s0\.00/);
});

it("hides the VAT row and the Tax invoice title at rate 0", () => {
	render(wrap(<InvoiceSheet invoice={make({ tax: null, subtotal: 1_200_000 })} locale="en-KE" />));
	expect(screen.getByTestId("invoice-title").textContent).toBe("INVOICE");
	expect(screen.queryByTestId("invoice-tax")).toBeNull();
	expect(screen.getByTestId("invoice-subtotal").textContent).toMatch(/KES\s12,000\.00/);
	expect(screen.getByTestId("invoice-total").textContent).toMatch(/KES\s12,000\.00/);
});

it("is white paper at most A4 wide, whatever the theme", () => {
	render(wrap(<InvoiceSheet invoice={make()} locale="en" />));
	const classes = screen.getByTestId("invoice-sheet").className;
	expect(classes).toContain("max-w-[210mm]");
	expect(classes).toContain("bg-white");
});

it("downloads the PDF through the procedure and saves it as <number>.pdf", async () => {
	const body = new Blob(["%PDF-1.7"], { type: "application/pdf" });
	state.pdf.mockResolvedValue({ headers: { "content-disposition": "attachment" }, body });
	render(wrap(<ReceiptPage invoiceId="a1" />));
	fireEvent.click(await screen.findByRole("button", { name: "Download invoice" }));
	await waitFor(() => expect(state.download).toHaveBeenCalled());
	expect(state.pdf.mock.calls[0]?.[0]).toEqual({ id: "a1" });
	expect(state.download.mock.calls[0]?.[0]).toBe(body);
	expect(state.download.mock.calls[0]?.[1]).toBe("INV-7F3K2Q-0003.pdf");
});

it("shows a toast and saves nothing when the download fails", async () => {
	state.pdf.mockRejectedValue(new Error("boom"));
	render(wrap(<ReceiptPage invoiceId="a1" />));
	fireEvent.click(await screen.findByRole("button", { name: "Download invoice" }));
	await waitFor(() => expect(state.toast).toHaveBeenCalled());
	expect(state.toast.mock.calls[0]?.[0]).toMatchObject({ type: "error" });
	expect(state.download).not.toHaveBeenCalled();
});

it("prints with the Print button and carries the A4 print rules", async () => {
	const print = vi.fn();
	vi.stubGlobal("print", print);
	const { container } = render(wrap(<ReceiptPage invoiceId="a1" />));
	fireEvent.click(await screen.findByRole("button", { name: "Print" }));
	expect(print).toHaveBeenCalled();
	const css = container.querySelector("style")?.textContent ?? "";
	expect(css).toContain("@page { size: A4; margin: 18mm; }");
	expect(css).toContain("body * { visibility: hidden");
	vi.unstubAllGlobals();
});

it("says so when the invoice is not found", async () => {
	state.invoice = undefined;
	state.invoiceError = { code: "NOT_FOUND" };
	render(wrap(<ReceiptPage invoiceId="nope" />));
	expect((await screen.findByTestId("receipt-missing")).textContent).toContain("This invoice was not found");
	expect(screen.queryByRole("button", { name: "Download invoice" })).toBeNull();
});
