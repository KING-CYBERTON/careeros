import type { InvoiceDocument } from "@careeros/invoice";
import type { ReactNode } from "react";
import { formatDay, formatMoney } from "@careeros/invoice";
import { PLATFORM_DEFAULT_APP_NAME } from "@reactive-resume/utils/brand";
import { Document, Page, Text, View } from "#react-pdf-renderer";

// CAREEROS (P3-T10): the invoice drawn with the Forme primitives. Neutral ink on white, one accent, A4 with 18 mm
// margins. The web page draws the same view model (`apps/web/src/features/billing/invoice-sheet.tsx`); keep the two
// layouts in step. Labels are English: the server has no translation catalogs (question Q541); the locale only sets
// how dates and amounts are written.
//
// A KRA eTIMS tax invoice also needs a control unit serial and QR code from KRA. That integration is out of scope; an
// optional "Tax compliance" row under the invoice number is where it will go.

const INK = "#111827";
const MUTED = "#6B7280";
const LINE = "#E5E7EB";
const ACCENT = "#337344";
const MARGIN = 51; // 18 mm in points

export type InvoiceFonts = { body: string | string[]; heading: string | string[] };

type TextProps = {
	children?: ReactNode;
	size?: number;
	bold?: boolean;
	muted?: boolean;
	color?: string;
	align?: "left" | "right" | "center";
	heading?: boolean;
	fonts: InvoiceFonts;
};

function T({ children, size = 9.5, bold, muted, color, align, heading, fonts }: TextProps) {
	return (
		<Text
			style={{
				fontFamily: heading ? fonts.heading : fonts.body,
				fontSize: size,
				fontWeight: bold ? 700 : 400,
				color: color ?? (muted ? MUTED : INK),
				lineHeight: 1.4,
				...(align ? { textAlign: align } : {}),
			}}
		>
			{children}
		</Text>
	);
}

const METHOD_LABEL = { card: "Card", mpesa: "M-Pesa", invoice: "Invoice" } as const;

type LabelledProps = { label: string; value: string; fonts: InvoiceFonts };

function Labelled({ label, value, fonts }: LabelledProps) {
	return (
		<View style={{ flexDirection: "row", gap: 8 }}>
			<View style={{ width: 52 }}>
				<T fonts={fonts} muted size={8.5}>
					{label}
				</T>
			</View>
			<View style={{ flex: 1 }}>
				<T fonts={fonts}>{value}</T>
			</View>
		</View>
	);
}

type InvoicePdfProps = { invoice: InvoiceDocument; locale: string; fonts: InvoiceFonts };

export function InvoicePdf({ invoice, locale, fonts }: InvoicePdfProps) {
	const money = (minor: number) => formatMoney(minor, invoice.currency, locale);
	const { seller, customer, payment, tax } = invoice;
	const sellerDetails = [seller.email, seller.phone, seller.taxPin ? `PIN ${seller.taxPin}` : null].filter(
		(value): value is string => Boolean(value),
	);
	const period =
		payment.periodStart && payment.periodEnd
			? `${formatDay(payment.periodStart, locale)} – ${formatDay(payment.periodEnd, locale)}`
			: null;
	const paid = invoice.status === "paid";
	const totals: [string, string, boolean][] = [
		["Subtotal", money(invoice.subtotal), false],
		...(tax ? ([[`${tax.label} ${tax.ratePercent}%`, money(tax.amount), false]] as [string, string, boolean][]) : []),
		["Total", money(invoice.total), true],
		["Amount paid", money(invoice.amountPaid), false],
		["Amount due", money(invoice.amountDue), true],
	];

	return (
		<Document title={`${tax ? "Tax invoice" : "Invoice"} ${invoice.number}`} author={seller.name} language={locale}>
			<Page size="A4" style={{ padding: MARGIN, backgroundColor: "#FFFFFF" }}>
				<View wrap={false} style={{ flexDirection: "row", justifyContent: "space-between" }}>
					<View style={{ flex: 1, gap: 2 }}>
						{/* The platform logo is a wordmark; Forme's Svg draws no <text>, so it is set as text in the UI font. */}
						<T fonts={fonts} heading bold size={22}>
							{PLATFORM_DEFAULT_APP_NAME}
						</T>
						<View style={{ height: 6 }} />
						{seller.name !== PLATFORM_DEFAULT_APP_NAME && (
							<T fonts={fonts} heading bold size={11}>
								{seller.name}
							</T>
						)}
						{seller.addressLines.map((line) => (
							<T key={line} fonts={fonts} muted size={9}>
								{line}
							</T>
						))}
						{sellerDetails.length > 0 && (
							<T fonts={fonts} muted size={9}>
								{sellerDetails.join("  ·  ")}
							</T>
						)}
					</View>
					<View style={{ width: 190, alignItems: "flex-end", gap: 2 }}>
						<T fonts={fonts} heading bold size={22} color={ACCENT} align="right">
							{tax ? "TAX INVOICE" : "INVOICE"}
						</T>
						<T fonts={fonts} bold size={10} align="right">
							{`No. ${invoice.number}`}
						</T>
						<T fonts={fonts} muted size={9} align="right">
							{`Issued ${formatDay(invoice.issuedAt, locale)}`}
						</T>
						{invoice.paidAt && (
							<T fonts={fonts} muted size={9} align="right">
								{`Paid ${formatDay(invoice.paidAt, locale)}`}
							</T>
						)}
						<View
							style={{
								marginTop: 6,
								paddingTop: 2,
								paddingBottom: 2,
								paddingLeft: 10,
								paddingRight: 10,
								borderWidth: 1,
								borderColor: paid ? ACCENT : "#B45309",
								borderRadius: 3,
							}}
						>
							<T fonts={fonts} bold size={9} color={paid ? ACCENT : "#B45309"}>
								{paid ? "PAID" : "DUE"}
							</T>
						</View>
					</View>
				</View>

				<View
					wrap={false}
					style={{
						flexDirection: "row",
						gap: 24,
						marginTop: 22,
						paddingTop: 14,
						borderTopWidth: 1,
						borderTopColor: LINE,
					}}
				>
					<View style={{ flex: 1, gap: 2 }}>
						<T fonts={fonts} bold muted size={8}>
							BILL TO
						</T>
						<T fonts={fonts} bold size={11}>
							{customer.name}
						</T>
						{customer.addressLines.map((line, index) => (
							<T key={`${index}-${line}`} fonts={fonts} size={9.5}>
								{line}
							</T>
						))}
						{customer.taxPin && <T fonts={fonts} size={9.5}>{`KRA PIN ${customer.taxPin}`}</T>}
						{customer.email && (
							<T fonts={fonts} muted size={9.5}>
								{customer.email}
							</T>
						)}
					</View>
					<View style={{ flex: 1, gap: 3 }}>
						<T fonts={fonts} bold muted size={8}>
							PAYMENT
						</T>
						<Labelled fonts={fonts} label="Method" value={payment.method ? METHOD_LABEL[payment.method] : "—"} />
						<Labelled fonts={fonts} label="Ref" value={payment.reference ?? "—"} />
						<Labelled fonts={fonts} label="Period" value={period ?? "—"} />
					</View>
				</View>

				<View style={{ marginTop: 22 }}>
					<View
						wrap={false}
						style={{
							flexDirection: "row",
							gap: 8,
							paddingBottom: 6,
							borderBottomWidth: 1,
							borderBottomColor: INK,
						}}
					>
						<View style={{ flex: 1 }}>
							<T fonts={fonts} bold muted size={8}>
								DESCRIPTION
							</T>
						</View>
						<View style={{ width: 34 }}>
							<T fonts={fonts} bold muted size={8} align="right">
								QTY
							</T>
						</View>
						<View style={{ width: 92 }}>
							<T fonts={fonts} bold muted size={8} align="right">
								UNIT PRICE
							</T>
						</View>
						<View style={{ width: 100 }}>
							<T fonts={fonts} bold muted size={8} align="right">
								AMOUNT
							</T>
						</View>
					</View>
					{invoice.lines.map((line, index) => (
						<View
							key={`${index}-${line.description}`}
							wrap={false}
							style={{
								flexDirection: "row",
								gap: 8,
								paddingTop: 8,
								paddingBottom: 8,
								borderBottomWidth: 1,
								borderBottomColor: LINE,
							}}
						>
							<View style={{ flex: 1, gap: 1 }}>
								<T fonts={fonts}>{line.description}</T>
								{line.detail && (
									<T fonts={fonts} muted size={8.5}>
										{line.detail}
									</T>
								)}
							</View>
							<View style={{ width: 34 }}>
								<T fonts={fonts} align="right">
									{String(line.quantity)}
								</T>
							</View>
							<View style={{ width: 92 }}>
								<T fonts={fonts} align="right">
									{line.unitAmount === null ? "" : money(line.unitAmount)}
								</T>
							</View>
							<View style={{ width: 100 }}>
								<T fonts={fonts} align="right">
									{money(line.amount)}
								</T>
							</View>
						</View>
					))}
				</View>

				<View wrap={false} style={{ marginTop: 14, alignItems: "flex-end" }}>
					<View style={{ width: 250, gap: 4 }}>
						{totals.map(([label, value, strong]) => (
							<View
								key={label}
								style={{
									flexDirection: "row",
									justifyContent: "space-between",
									...(strong && label === "Total" ? { paddingTop: 5, borderTopWidth: 1, borderTopColor: INK } : {}),
								}}
							>
								<T fonts={fonts} bold={strong} size={strong ? 10.5 : 9.5}>
									{label}
								</T>
								<T fonts={fonts} bold={strong} size={strong ? 10.5 : 9.5} align="right">
									{value}
								</T>
							</View>
						))}
					</View>
				</View>

				<View wrap={false} style={{ marginTop: 34, paddingTop: 10, borderTopWidth: 1, borderTopColor: LINE, gap: 2 }}>
					{invoice.footer && (
						<T fonts={fonts} muted size={8.5}>
							{invoice.footer}
						</T>
					)}
					<T fonts={fonts} muted size={8.5}>
						Thank you for your business.
					</T>
				</View>
			</Page>
		</Document>
	);
}
