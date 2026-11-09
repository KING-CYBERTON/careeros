import type { BillingSnapshot } from "./lib";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { billingStateKind, daysUntil } from "./lib";
import { SettingsSection } from "@/features/settings/section";

// CAREEROS (P3-T06): the plan, status, seats, period, payment method and AI credits of the organization.

export type SummaryData = BillingSnapshot & {
	memberCount: number;
	plans: { id: string; name: string; seatLimit: number | null }[];
};

export type CreditsData = { used: number; allowance: number };

type BillingSummaryProps = {
	billing: SummaryData;
	credits: CreditsData | undefined;
	/** How the last payment was made, when known. */
	method: "card" | "mpesa" | null;
	locale: string;
	/** For tests; defaults to the time the screen opened. */
	now?: Date;
};

const formatDate = (date: Date | null, locale: string) =>
	date ? date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : null;

export function BillingSummary({ billing, credits, method, locale, now }: BillingSummaryProps) {
	const [opened] = useState(() => new Date());
	const kind = billingStateKind(billing);
	const sub = billing.subscription;
	const plan = billing.plans.find((entry) => entry.id === billing.planId);
	const planName = plan?.name ?? billing.planId;
	const seatLimit = sub.seats > 0 && sub.status !== "none" ? sub.seats : (plan?.seatLimit ?? null);
	const trialDays = daysUntil(sub.trialEndsAt, now ?? opened);
	const graceEnd = formatDate(sub.graceEndsAt, locale);
	const periodEnd = formatDate(sub.currentPeriodEnd, locale);

	const status = {
		trial: { variant: "info", label: t`Trial` },
		active: { variant: "accent", label: t`Active` },
		canceling: { variant: "warn", label: t`Ends at period end` },
		past_due: { variant: "warn", label: t`Past due` },
		suspended: { variant: "danger", label: t`Suspended` },
	} as const;

	const detail = {
		trial: <Trans>{trialDays ?? 0} days left in the trial.</Trans>,
		active: periodEnd ? <Trans>Renews or ends on {periodEnd}.</Trans> : null,
		canceling: <Trans>Canceled. The organization keeps working until {periodEnd ?? "the period ends"}.</Trans>,
		past_due: <Trans>Payment failed. Pay by {graceEnd ?? "the grace end date"} to avoid suspension.</Trans>,
		suspended: <Trans>Members can view and export data but not change it until a payment is made.</Trans>,
	}[kind];

	const methodLabel = method === "card" ? t`Card` : method === "mpesa" ? t`M-Pesa` : null;
	const percent =
		credits && credits.allowance > 0 ? Math.min(100, Math.round((credits.used / credits.allowance) * 100)) : null;

	return (
		<SettingsSection title={<Trans>Your plan</Trans>} className="max-w-none">
			<div className="flex flex-wrap items-center gap-3" data-testid="billing-summary">
				<span className="font-display text-2xl font-medium" data-testid="billing-plan-name">
					{planName}
				</span>
				<Badge variant={status[kind].variant} data-testid="billing-status">
					{status[kind].label}
				</Badge>
			</div>
			{detail && (
				<p className="text-sm text-ink-2" data-testid="billing-status-detail">
					{detail}
				</p>
			)}
			<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<div className="rounded-xl p-3 outline outline-line">
					<dt className="text-[13px] text-ink-3">
						<Trans>Seats</Trans>
					</dt>
					<dd className="text-xl font-semibold tabular-nums" data-testid="billing-seats">
						{seatLimit === null ? (
							<Trans>{billing.memberCount} used</Trans>
						) : (
							<Trans>
								{billing.memberCount} of {seatLimit}
							</Trans>
						)}
					</dd>
				</div>
				<div className="rounded-xl p-3 outline outline-line">
					<dt className="text-[13px] text-ink-3">
						<Trans>Current period</Trans>
					</dt>
					<dd className="text-sm font-medium">
						{sub.currentPeriodStart && sub.currentPeriodEnd ? (
							<>
								{formatDate(sub.currentPeriodStart, locale)} – {periodEnd}
							</>
						) : (
							"—"
						)}
					</dd>
				</div>
				<div className="rounded-xl p-3 outline outline-line">
					<dt className="text-[13px] text-ink-3">
						<Trans>Payment method</Trans>
					</dt>
					<dd className="text-sm font-medium" data-testid="billing-method">
						{methodLabel ?? "—"}
					</dd>
				</div>
				<div className="rounded-xl p-3 outline outline-line">
					<dt className="text-[13px] text-ink-3">
						<Trans>AI credits</Trans>
					</dt>
					<dd className="text-sm font-medium tabular-nums" data-testid="billing-credits">
						{credits ? (
							<Trans>
								{credits.used} used, {Math.max(0, credits.allowance - credits.used)} left
							</Trans>
						) : (
							"—"
						)}
					</dd>
				</div>
			</dl>
			{percent !== null && (
				<div
					role="progressbar"
					aria-label={t`AI credits used this period`}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
					className="h-2 overflow-hidden rounded-full bg-sunken"
				>
					<div className="h-full bg-ink" style={{ width: `${percent}%` }} />
				</div>
			)}
		</SettingsSection>
	);
}
