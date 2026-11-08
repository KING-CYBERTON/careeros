import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { ErrorNotice, formatDate } from "./shared";
import { PageHeader } from "@/components/layout/page-header";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P3-T07): the organizations list. No member names or emails are shown or returned here.

const PAGE_SIZE = 25;

export function OrganizationsPage() {
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState<"" | "active" | "suspended">("");
	const [planId, setPlanId] = useState("");
	const [offset, setOffset] = useState(0);
	const plans = useQuery(orpc.admin.plans.queryOptions());
	const list = useQuery({
		...orpc.admin.orgs.list.queryOptions({
			input: {
				...(search.trim() ? { search: search.trim() } : {}),
				...(status ? { status } : {}),
				...(planId ? { planId } : {}),
				limit: PAGE_SIZE,
				offset,
			},
		}),
		placeholderData: keepPreviousData,
	});
	const total = list.data?.total ?? 0;

	return (
		<div className="grid gap-5">
			<PageHeader
				title={<Trans>Organizations</Trans>}
				description={<Trans>Every organization on the platform. Opening one is recorded in the audit log.</Trans>}
			>
				<Input
					type="search"
					aria-label={t`Search by name or address`}
					placeholder={t`Search by name or address`}
					className="w-64"
					value={search}
					onChange={(event) => {
						setSearch(event.target.value);
						setOffset(0);
					}}
				/>
				<NativeSelect
					aria-label={t`Status`}
					className="w-40"
					value={status}
					onChange={(event) => {
						setStatus(event.target.value as typeof status);
						setOffset(0);
					}}
				>
					<option value="">{t`Any status`}</option>
					<option value="active">{t`Active`}</option>
					<option value="suspended">{t`Suspended`}</option>
				</NativeSelect>
				<NativeSelect
					aria-label={t`Plan`}
					className="w-40"
					value={planId}
					onChange={(event) => {
						setPlanId(event.target.value);
						setOffset(0);
					}}
				>
					<option value="">{t`Any plan`}</option>
					{plans.data?.map((plan) => (
						<option key={plan.id} value={plan.id}>
							{plan.name}
						</option>
					))}
				</NativeSelect>
			</PageHeader>

			{list.error ? (
				<ErrorNotice error={list.error} title={<Trans>Couldn't load organizations</Trans>} />
			) : !list.data ? (
				<Skeleton className="h-64 rounded-xl" />
			) : (
				<>
					<div className="overflow-x-auto rounded-xl border border-line">
						<table className="w-full min-w-[720px] text-start text-sm" data-testid="admin-orgs-table">
							<thead className="bg-sunken text-xs text-ink-3">
								<tr>
									<th className="px-3 py-2 text-start font-medium">{t`Organization`}</th>
									<th className="px-3 py-2 text-start font-medium">{t`Plan`}</th>
									<th className="px-3 py-2 text-start font-medium">{t`Status`}</th>
									<th className="px-3 py-2 text-end font-medium">{t`Seats`}</th>
									<th className="px-3 py-2 text-end font-medium">{t`AI credits`}</th>
									<th className="px-3 py-2 text-start font-medium">{t`Last active`}</th>
								</tr>
							</thead>
							<tbody>
								{list.data.rows.map((org) => (
									<tr key={org.id} className="border-t border-line">
										<td className="px-3 py-2">
											<Link
												to="/admin/organizations/$organizationId"
												params={{ organizationId: org.id }}
												className="font-medium text-accent-text underline-offset-4 hover:underline"
											>
												{org.name}
											</Link>
											<div className="text-xs text-ink-3">{org.slug}</div>
										</td>
										<td className="px-3 py-2">{org.planName}</td>
										<td className="px-3 py-2">
											<Badge variant={org.status === "suspended" ? "danger" : "accent"}>{org.status}</Badge>
										</td>
										<td className="px-3 py-2 text-end tabular-nums">
											{org.seatsUsed} / {org.seatLimit ?? "∞"}
										</td>
										<td className="px-3 py-2 text-end tabular-nums">{org.aiCreditsUsed}</td>
										<td className="px-3 py-2 text-ink-2">{formatDate(org.lastActiveAt)}</td>
									</tr>
								))}
								{list.data.rows.length === 0 && (
									<tr>
										<td colSpan={6} className="px-3 py-8 text-center text-ink-3">
											<Trans>No organizations match.</Trans>
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
					<div className="flex items-center justify-between text-sm text-ink-2">
						<span>
							{total === 0 ? "0" : `${offset + 1}-${Math.min(offset + PAGE_SIZE, total)}`} / {total}
						</span>
						<div className="flex gap-2">
							<Button
								variant="secondary"
								size="sm"
								disabled={offset === 0}
								onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
							>
								<Trans>Previous</Trans>
							</Button>
							<Button
								variant="secondary"
								size="sm"
								disabled={offset + PAGE_SIZE >= total}
								onClick={() => setOffset(offset + PAGE_SIZE)}
							>
								<Trans>Next</Trans>
							</Button>
						</div>
					</div>
				</>
			)}
		</div>
	);
}
