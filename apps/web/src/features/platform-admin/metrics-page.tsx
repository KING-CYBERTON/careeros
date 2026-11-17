import type { ReactNode } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { ErrorNotice, formatDate, formatMicros, formatMoney } from "./shared";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P3-T07): counts, MRR, revenue and AI cost for a range (the last 30 days by default).

type StatProps = { label: string; children: ReactNode };
function Stat({ label, children }: StatProps) {
	return (
		<div className="grid gap-0.5 rounded-xl border border-line px-4 py-3">
			<span className="text-xs text-ink-3">{label}</span>
			<span className="text-xl font-semibold tabular-nums">{children}</span>
		</div>
	);
}

export function MetricsPage() {
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const input = useMemo(
		() => ({
			...(from ? { from: new Date(`${from}T00:00:00Z`) } : {}),
			...(to ? { to: new Date(`${to}T00:00:00Z`) } : {}),
		}),
		[from, to],
	);
	const query = useQuery(orpc.admin.metrics.queryOptions({ input }));
	const metrics = query.data;

	return (
		<div className="grid gap-6">
			<PageHeader
				title={<Trans>Metrics</Trans>}
				description={<Trans>Revenue and costs are shown per currency. Nothing is converted.</Trans>}
			>
				<div className="flex flex-wrap items-end gap-3">
					<div className="grid gap-1">
						<Label htmlFor="metrics-from">{t`From`}</Label>
						<Input id="metrics-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
					</div>
					<div className="grid gap-1">
						<Label htmlFor="metrics-to">{t`To`}</Label>
						<Input id="metrics-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
					</div>
				</div>
			</PageHeader>
			{query.error ? (
				<ErrorNotice error={query.error} title={<Trans>Couldn't load metrics</Trans>} />
			) : !metrics ? (
				<Skeleton className="h-64 rounded-xl" />
			) : (
				<div className="grid gap-6" data-testid="admin-metrics">
					<p className="text-sm text-ink-3">
						{formatDate(metrics.from)} - {formatDate(metrics.to)}
					</p>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<Stat label={t`New organizations`}>{metrics.newOrgs}</Stat>
						<Stat label={t`Active members`}>{metrics.activeMembers}</Stat>
						<Stat label={t`AI cost`}>{formatMicros(metrics.aiCostUsdMicros)}</Stat>
						<Stat label={t`MRR`}>
							{metrics.mrr.length === 0
								? "-"
								: metrics.mrr.map((row) => <div key={row.currency}>{formatMoney(row.amountMinor, row.currency)}</div>)}
						</Stat>
					</div>
					<div className="grid gap-6 sm:grid-cols-3">
						<SettingsSection title={<Trans>Organizations by status</Trans>}>
							<Counts rows={metrics.orgsByStatus} />
						</SettingsSection>
						<SettingsSection title={<Trans>Organizations by plan</Trans>}>
							<Counts rows={metrics.orgsByPlan} />
						</SettingsSection>
						<SettingsSection title={<Trans>Revenue in range</Trans>}>
							<ul className="grid gap-1 text-sm">
								{metrics.revenue.map((row) => (
									<li key={row.currency}>{formatMoney(row.amountMinor, row.currency)}</li>
								))}
								{metrics.revenue.length === 0 && <li className="text-ink-3">-</li>}
							</ul>
						</SettingsSection>
					</div>
					<SettingsSection
						title={<Trans>AI cost by organization</Trans>}
						description={<Trans>Highest first, with the revenue of the range beside it.</Trans>}
					>
						<div className="overflow-x-auto rounded-xl border border-line">
							<table className="w-full min-w-[560px] text-sm">
								<thead className="bg-sunken text-xs text-ink-3">
									<tr>
										<th className="px-3 py-2 text-start font-medium">{t`Organization`}</th>
										<th className="px-3 py-2 text-end font-medium">{t`Credits`}</th>
										<th className="px-3 py-2 text-end font-medium">{t`AI cost`}</th>
										<th className="px-3 py-2 text-end font-medium">{t`Revenue`}</th>
									</tr>
								</thead>
								<tbody>
									{metrics.aiCostByOrg.map((row) => (
										<tr key={row.organizationId} className="border-t border-line">
											<td className="px-3 py-2">
												<Link
													to="/admin/organizations/$organizationId"
													params={{ organizationId: row.organizationId }}
													className="text-accent-text underline-offset-4 hover:underline"
												>
													{row.name}
												</Link>
											</td>
											<td className="px-3 py-2 text-end tabular-nums">{row.credits}</td>
											<td className="px-3 py-2 text-end tabular-nums">{formatMicros(row.costUsdMicros)}</td>
											<td className="px-3 py-2 text-end tabular-nums">
												{row.revenue.map((r) => formatMoney(r.amountMinor, r.currency)).join(", ") || "-"}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</SettingsSection>
				</div>
			)}
		</div>
	);
}

type CountsProps = { rows: Record<string, number> };
function Counts({ rows }: CountsProps) {
	const entries = Object.entries(rows);
	return (
		<ul className="grid gap-1 text-sm">
			{entries.map(([key, value]) => (
				<li key={key} className="flex justify-between gap-4">
					<span>{key}</span>
					<span className="tabular-nums">{value}</span>
				</li>
			))}
			{entries.length === 0 && <li className="text-ink-3">-</li>}
		</ul>
	);
}
