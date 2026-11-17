import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { RequireOrgAdmin } from "./access";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

/** CAREEROS (P3-T08): Settings → AI usage. The pooled credits of the period: used, left, by feature and by member. */
export function AiUsageSettings() {
	return (
		<>
			<PageHeader
				title={<Trans>AI usage</Trans>}
				description={<Trans>Credits your members have used of the organization's pooled allowance this period.</Trans>}
			/>
			<RequireOrgAdmin>
				<AiUsageBody />
			</RequireOrgAdmin>
		</>
	);
}

function AiUsageBody() {
	const usage = useQuery(orpc.aiUsage.summary.queryOptions({ input: undefined }));
	if (usage.error)
		return (
			<Alert variant="error">
				<Icon name="warning-circle" />
				<AlertTitle>
					<Trans>Couldn't load AI usage</Trans>
				</AlertTitle>
				<AlertDescription>{getReadableErrorMessage(usage.error, t`Try again in a moment.`)}</AlertDescription>
			</Alert>
		);
	if (!usage.data) return <Skeleton className="h-40 rounded-xl" />;

	const { used, allowance, period, overageAllowed, byFeature, byMember } = usage.data;
	const percent = allowance > 0 ? Math.min(100, Math.round((used / allowance) * 100)) : 100;
	const left = Math.max(0, allowance - used);
	const exceeded = used >= allowance;
	const warning = !exceeded && allowance > 0 && used * 5 >= allowance * 4;

	return (
		<>
			<SettingsSection
				title={<Trans>This period</Trans>}
				description={
					<Trans>
						{period.start.toLocaleDateString()} to {period.end.toLocaleDateString()}
					</Trans>
				}
			>
				{(exceeded || warning) && (
					<Alert variant={exceeded ? "error" : "warn"} data-testid="ai-usage-threshold">
						<Icon name="warning-circle" />
						<AlertTitle>
							{exceeded ? (
								<Trans>All of the pooled credits are used</Trans>
							) : (
								<Trans>80% of the pooled credits are used</Trans>
							)}
						</AlertTitle>
						{exceeded && (
							<AlertDescription>
								{overageAllowed ? (
									<Trans>Your plan allows going over; extra use is billed.</Trans>
								) : (
									<Trans>
										AI features that use the platform's model stay off until the next period or a larger plan.
									</Trans>
								)}
							</AlertDescription>
						)}
					</Alert>
				)}
				<dl className="grid grid-cols-3 gap-3" data-testid="ai-usage-totals">
					{[
						[t`Used`, used],
						[t`Left`, left],
						[t`Pooled`, allowance],
					].map(([label, value]) => (
						<div key={label} className="rounded-xl p-3 outline outline-line">
							<dt className="text-[13px] text-ink-3">{label}</dt>
							<dd className="text-2xl font-semibold tabular-nums">{value}</dd>
						</div>
					))}
				</dl>
				<div
					role="progressbar"
					aria-label={t`Pooled credits used`}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
					className="h-2 overflow-hidden rounded-full bg-sunken"
				>
					<div className="h-full bg-ink" style={{ width: `${percent}%` }} />
				</div>
			</SettingsSection>

			<SettingsSection title={<Trans>By feature</Trans>}>
				{byFeature.length === 0 ? (
					<p className="text-sm text-ink-2">
						<Trans>No platform AI use yet.</Trans>
					</p>
				) : (
					<ul className="divide-y divide-line overflow-hidden rounded-xl outline outline-line">
						{byFeature.map((row) => (
							<li key={row.feature} className="flex items-center justify-between gap-3 p-3 text-sm">
								<span>{row.feature}</span>
								<span className="text-ink-2 tabular-nums">
									<Trans>
										{row.credits} credits · {row.calls} calls
									</Trans>
								</span>
							</li>
						))}
					</ul>
				)}
			</SettingsSection>

			<SettingsSection title={<Trans>By member</Trans>} description={<Trans>The 20 members who used the most.</Trans>}>
				{byMember.length === 0 ? (
					<p className="text-sm text-ink-2">
						<Trans>No platform AI use yet.</Trans>
					</p>
				) : (
					<ul className="divide-y divide-line overflow-hidden rounded-xl outline outline-line">
						{byMember.map((row) => (
							<li key={row.userId ?? "removed"} className="flex items-center justify-between gap-3 p-3 text-sm">
								<span className="truncate">{row.name ?? t`Removed member`}</span>
								<span className="text-ink-2 tabular-nums">
									<Trans>
										{row.credits} credits · {row.calls} calls
									</Trans>
								</span>
							</li>
						))}
					</ul>
				)}
			</SettingsSection>
		</>
	);
}
