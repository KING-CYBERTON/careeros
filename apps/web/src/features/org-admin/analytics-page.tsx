import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { downloadWithAnchor } from "@reactive-resume/utils/file";
import { RequireOrgAdmin } from "./access";
import { useCohorts } from "./queries";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { getReadableErrorMessage } from "@/libs/error-message";
import { client, orpc } from "@/libs/orpc/client";

type Sort = "name" | "email" | "cohort" | "lastActive" | "resumes" | "applications" | "interviews" | "offers";

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const defaultRange = () => {
	const to = new Date();
	return { from: isoDay(new Date(to.getTime() - 29 * 86_400_000)), to: isoDay(to) };
};

/** CAREEROS (P3-T08): Settings → Analytics. Counts for a date range and an optional cohort, with CSV export. */
export function AnalyticsSettings() {
	return (
		<>
			<PageHeader
				title={<Trans>Analytics</Trans>}
				description={<Trans>How your members are doing: resumes, applications, interviews and offers.</Trans>}
			/>
			<RequireOrgAdmin>
				<AnalyticsBody />
			</RequireOrgAdmin>
		</>
	);
}

function AnalyticsBody() {
	const fromId = useId();
	const toId = useId();
	const cohortFilterId = useId();
	const [range, setRange] = useState(defaultRange);
	const [cohortId, setCohortId] = useState("");
	const [sort, setSort] = useState<Sort>("name");
	const [direction, setDirection] = useState<"asc" | "desc">("asc");
	const [page, setPage] = useState(1);
	const [exporting, setExporting] = useState<"members" | "summary" | null>(null);
	const { data: cohorts } = useCohorts(true);
	const filters = { from: range.from, to: range.to, ...(cohortId ? { cohortId } : {}) };

	const summary = useQuery(orpc.orgAdmin.analytics.summary.queryOptions({ input: filters }));
	const table = useQuery(
		orpc.orgAdmin.analytics.members.queryOptions({ input: { ...filters, sort, direction, page } }),
	);

	const download = async (kind: "members" | "summary") => {
		setExporting(kind);
		try {
			const result =
				kind === "members"
					? await client.orgAdmin.analytics.exportMembers(filters)
					: await client.orgAdmin.analytics.exportSummary(filters);
			downloadWithAnchor(result.body, `analytics-${kind}-${range.from}-to-${range.to}.csv`);
		} catch (error) {
			toast.add({ type: "error", description: getReadableErrorMessage(error, t`Couldn't export. Try again.`) });
		} finally {
			setExporting(null);
		}
	};

	const sortBy = (next: Sort) => {
		setPage(1);
		if (next === sort) setDirection(direction === "asc" ? "desc" : "asc");
		else {
			setSort(next);
			setDirection(next === "name" || next === "email" || next === "cohort" ? "asc" : "desc");
		}
	};
	const header = (key: Sort, label: string) => (
		<th
			scope="col"
			className="px-3 py-2 text-start font-medium"
			aria-sort={sort === key ? (direction === "asc" ? "ascending" : "descending") : "none"}
		>
			<button type="button" className="inline-flex items-center gap-1" onClick={() => sortBy(key)}>
				{label}
				{sort === key && <Icon name={direction === "asc" ? "arrow-up" : "arrow-down"} size={14} />}
			</button>
		</th>
	);

	const pages = table.data ? Math.max(1, Math.ceil(table.data.total / table.data.pageSize)) : 1;
	const stages = summary.data?.applicationsByStage;

	return (
		<>
			<SettingsSection title={<Trans>Filters</Trans>} description={<Trans>Up to 366 days, in UTC.</Trans>}>
				<div className="flex flex-wrap items-end gap-3">
					<div className="grid gap-1.5">
						<Label htmlFor={fromId}>
							<Trans>From</Trans>
						</Label>
						<Input
							id={fromId}
							type="date"
							value={range.from}
							max={range.to}
							onChange={(event) => {
								setPage(1);
								setRange({ ...range, from: event.target.value });
							}}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor={toId}>
							<Trans>To</Trans>
						</Label>
						<Input
							id={toId}
							type="date"
							value={range.to}
							min={range.from}
							onChange={(event) => {
								setPage(1);
								setRange({ ...range, to: event.target.value });
							}}
						/>
					</div>
					<div className="grid w-52 gap-1.5">
						<Label htmlFor={cohortFilterId}>
							<Trans>Cohort</Trans>
						</Label>
						<NativeSelect
							id={cohortFilterId}
							value={cohortId}
							onChange={(event) => {
								setPage(1);
								setCohortId(event.target.value);
							}}
						>
							<option value="">{t`All members`}</option>
							{cohorts?.map((cohort) => (
								<option key={cohort.id} value={cohort.id}>
									{cohort.name}
								</option>
							))}
						</NativeSelect>
					</div>
				</div>
			</SettingsSection>

			{summary.error ? (
				<Alert variant="error">
					<Icon name="warning-circle" />
					<AlertTitle>
						<Trans>Couldn't load analytics</Trans>
					</AlertTitle>
					<AlertDescription>
						{getReadableErrorMessage(summary.error, t`Check the dates and try again.`)}
					</AlertDescription>
				</Alert>
			) : (
				<SettingsSection
					title={<Trans>Summary</Trans>}
					action={
						<Button
							size="sm"
							variant="secondary"
							disabled={exporting !== null}
							onClick={() => void download("summary")}
						>
							<Icon name="download-simple" size={16} />
							<Trans>Export summary</Trans>
						</Button>
					}
				>
					{summary.isLoading || !summary.data || !stages ? (
						<Skeleton className="h-28 rounded-xl" />
					) : (
						<dl className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="analytics-summary">
							{[
								[t`Members`, summary.data.members],
								[t`Active members`, summary.data.activeMembers],
								[t`Resumes created`, summary.data.resumesCreated],
								[t`Applications created`, summary.data.applicationsCreated],
								[t`Interviews`, summary.data.interviews],
								[t`Offers`, summary.data.offers],
							].map(([label, value]) => (
								<div key={label} className="rounded-xl p-3 outline outline-line">
									<dt className="text-[13px] text-ink-3">{label}</dt>
									<dd className="text-2xl font-semibold tabular-nums">{value}</dd>
								</div>
							))}
						</dl>
					)}
					{stages && (
						<p className="text-sm text-ink-2">
							<Trans>
								By stage: saved {stages.saved}, applied {stages.applied}, screening {stages.screening}, interview{" "}
								{stages.interview}, offer {stages.offer}, closed {stages.closed}.
							</Trans>
						</p>
					)}
				</SettingsSection>
			)}

			<SettingsSection
				title={<Trans>Members</Trans>}
				action={
					<Button size="sm" variant="secondary" disabled={exporting !== null} onClick={() => void download("members")}>
						<Icon name="download-simple" size={16} />
						<Trans>Export members</Trans>
					</Button>
				}
			>
				{table.isLoading || !table.data ? (
					<Skeleton className="h-40 rounded-xl" />
				) : (
					<div className="overflow-x-auto rounded-xl outline outline-line">
						<table className="w-full min-w-[720px] text-sm" data-testid="analytics-members">
							<thead className="bg-sunken text-ink-2">
								<tr>
									{header("name", t`Name`)}
									{header("email", t`Email`)}
									{header("cohort", t`Cohort`)}
									{header("lastActive", t`Last active`)}
									{header("resumes", t`Resumes`)}
									{header("applications", t`Applications`)}
									{header("interviews", t`Interviews`)}
									{header("offers", t`Offers`)}
								</tr>
							</thead>
							<tbody className="divide-y divide-line">
								{table.data.items.map((row) => (
									<tr key={row.memberId}>
										<td className="px-3 py-2">{row.name}</td>
										<td className="px-3 py-2 text-ink-2">{row.email}</td>
										<td className="px-3 py-2">{row.cohortName ?? "—"}</td>
										<td className="px-3 py-2 whitespace-nowrap">
											{row.lastActiveAt ? row.lastActiveAt.toLocaleDateString() : "—"}
										</td>
										<td className="px-3 py-2 tabular-nums">{row.resumes}</td>
										<td className="px-3 py-2 tabular-nums">{row.applications}</td>
										<td className="px-3 py-2 tabular-nums">{row.interviews}</td>
										<td className="px-3 py-2 tabular-nums">{row.offers}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{pages > 1 && (
					<div className="flex items-center justify-between gap-3 text-sm text-ink-2">
						<Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
							<Trans>Previous</Trans>
						</Button>
						<span>
							<Trans>
								Page {page} of {pages}
							</Trans>
						</span>
						<Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>
							<Trans>Next</Trans>
						</Button>
					</div>
				)}
			</SettingsSection>
		</>
	);
}
