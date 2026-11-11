import type { InvoiceFonts } from "./document";
import type { InvoiceDocument } from "@careeros/invoice";
import type { ResumeData, Typography } from "@reactive-resume/schema/resume/data";
import type { Locale } from "@reactive-resume/utils/locale";
import * as forme from "@formepdf/core";
import { createElement } from "react";
import { loadFonts } from "../forme/fonts";
import { renderHostTree } from "../forme/reconciler";
import { toFormeDocument } from "../forme/to-forme";
import { resolvePdfFonts, resumeContentScripts } from "../hooks/use-register-fonts";
import { InvoicePdf } from "./document";

// CAREEROS (P3-T10): the invoice PDF, rendered on the server with Forme so the file is the same in every browser and the
// numbers come from one place. Fonts go through the same resolution as resumes: Figtree (the UI font) plus a fallback
// per writing system the customer's name or address needs, so a name in another script is not drawn as "?".

const INVOICE_TYPOGRAPHY: Typography = {
	body: { fontFamily: "Figtree", fontWeights: ["400", "700"], fontSize: 10, lineHeight: 1.4 },
	heading: { fontFamily: "Figtree", fontWeights: ["700"], fontSize: 14, lineHeight: 1.4 },
};

export type CreateInvoicePdfOptions = { locale: string; webFontBaseUrl?: string | undefined };

/** The text the invoice prints, for choosing the fallback fonts. */
function invoiceStrings(invoice: InvoiceDocument): string {
	return [
		invoice.number,
		invoice.seller.name,
		...invoice.seller.addressLines,
		invoice.seller.email,
		invoice.seller.phone,
		invoice.seller.taxPin,
		invoice.customer.name,
		...invoice.customer.addressLines,
		invoice.customer.taxPin,
		invoice.customer.email,
		invoice.payment.reference,
		invoice.footer,
		...invoice.lines.flatMap((line) => [line.description, line.detail]),
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");
}

/** Renders the invoice to a one-page (for one line item) A4 PDF named `<number>.pdf`. */
export async function createInvoicePdfFile(invoice: InvoiceDocument, options: CreateInvoicePdfOptions): Promise<File> {
	const { locale } = options;
	// `resumeContentScripts` reads only these four fields of a resume; the invoice's text goes in as the name.
	const scripts = resumeContentScripts({
		basics: { name: invoiceStrings(invoice) },
		summary: "",
		sections: {},
		customSections: [],
	} as unknown as ResumeData);
	const { typography, fonts: requests } = resolvePdfFonts(INVOICE_TYPOGRAPHY, locale as Locale, scripts, false);
	const families: InvoiceFonts = { body: typography.body.fontFamily, heading: typography.heading.fontFamily };

	const { fonts, missing } = await loadFonts(requests, options.webFontBaseUrl);
	// A failed download would print the invoice in other fonts: fail so the caller can retry.
	if (missing.length > 0)
		throw new Error(`Fonts could not be loaded: ${[...new Set(missing)].join(", ")}. Retry the download.`);

	const { document } = toFormeDocument(renderHostTree(createElement(InvoicePdf, { invoice, locale, fonts: families })));
	const result = await forme.renderSerializedDocWithLayout({ ...document, fonts: fonts.map((font) => ({ ...font })) });
	return new File([result.pdf as Uint8Array<ArrayBuffer>], `${invoice.number}.pdf`, { type: "application/pdf" });
}
