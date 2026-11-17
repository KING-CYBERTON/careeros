import type { BannerKind } from "./lib";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Link, useRouteContext } from "@tanstack/react-router";
import { Icon } from "@reactive-resume/ui/components/icon";
import { daysUntil, ownerBannerKind } from "./lib";
import { useBilling, useOrganizationRole } from "./queries";

// CAREEROS (P3-T06): the billing strip across the dashboard. The owner sees the trial ending (3 days or less), a past
// due payment with the grace end date, or a suspension with a link to billing. Everyone else sees a short notice to
// contact the owner when a payment is overdue. Only a courtesy: the server is the guard on every write.

type StripProps = { children: React.ReactNode; testId: string };

function Strip({ children, testId }: StripProps) {
	return (
		<div
			role="status"
			data-testid={testId}
			className="flex w-full items-center gap-2.5 bg-warn-soft px-4 py-2.5 text-[13px] leading-[19px] text-warn-text"
		>
			<Icon name="warning-circle" size={18} className="shrink-0" />
			<p>{children}</p>
		</div>
	);
}

type OwnerBillingBannerProps = { kind: BannerKind; trialDays: number | null; graceEnd: string | null };

export function OwnerBillingBanner({ kind, trialDays, graceEnd }: OwnerBillingBannerProps) {
	const link = (
		<Link to="/dashboard/organization/billing" className="font-medium underline">
			<Trans>Open billing</Trans>
		</Link>
	);
	return (
		<Strip testId={`billing-banner-${kind}`}>
			{kind === "trial_ending" && <Trans>Your trial ends in {trialDays ?? 0} days. Pick a plan to keep going. </Trans>}
			{kind === "past_due" && (
				<Trans>Your last payment failed. Pay by {graceEnd ?? "the grace end date"} to avoid suspension. </Trans>
			)}
			{kind === "suspended" && <Trans>Your organization is suspended. Make a payment to restore it. </Trans>}
			{link}
		</Strip>
	);
}

export function MemberBillingNotice() {
	return (
		<Strip testId="billing-banner-member">
			<Trans>Your organization has an overdue payment. Please contact your organization's owner.</Trans>
		</Strip>
	);
}

/** Mounted once in the dashboard shell. */
export function BillingBanner() {
	const { flags } = useRouteContext({ strict: false });
	const { i18n } = useLingui();
	const role = useOrganizationRole();
	const status = flags?.organization?.status;
	const isOwner = role === "owner";
	const billing = useBilling({ enabled: isOwner && status !== undefined && status !== "active" });

	if (role === "unknown" || !status) return null;
	if (!isOwner) return status === "past_due" ? <MemberBillingNotice /> : null;
	if (!billing.data?.billingEnabled) return null;
	const kind = ownerBannerKind(billing.data);
	if (!kind) return null;
	return (
		<OwnerBillingBanner
			kind={kind}
			trialDays={daysUntil(billing.data.subscription.trialEndsAt)}
			graceEnd={billing.data.subscription.graceEndsAt?.toLocaleDateString(i18n.locale) ?? null}
		/>
	);
}
