import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { ErrorNotice, formatDate } from "./shared";
import { PageHeader } from "@/components/layout/page-header";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P3-T07): the audit log of every organization and of the platform, newest first. Opening this page is
// itself recorded (`admin.audit_viewed`).

const PAGE = 50;

export function AuditPage() {
	const [organizationId, setOrganizationId] = useState("");
	const [action, setAction] = useState("");
	const [platformOnly, setPlatformOnly] = useState(false);
	// The cursor of each page shown so far: the id of the last entry of the page before.
	const [cursors, setCursors] = useState<string[]>([]);
	const before = cursors.at(-1);
	const query = useQuery(
		orpc.admin.audit.list.queryOptions({
			input: {
				...(organizationId.trim() ? { organizationId: organizationId.trim() } : {}),
				...(action.trim() ? { action: action.trim() } : {}),
				...(platformOnly ? { platformOnly: true } : {}),
				...(before ? { before } : {}),
				limit: PAGE,
			},
		}),
	);
	const rows = query.data ?? [];
	const reset = () => setCursors([]);

	return (
		<div className="grid gap-5">
			<PageHeader
				title={<Trans>Audit log</Trans>}
				description={<Trans>Every organization and the platform, newest first.</Trans>}
			>
				<Input
					aria-label={t`Organization id`}
					placeholder={t`Organization id`}
					className="w-64"
					value={organizationId}
					onChange={(event) => {
						setOrganizationId(event.target.value);
						reset();
					}}
				/>
				<Input
					aria-label={t`Action`}
					placeholder={t`Action, for example admin.org_status_set`}
					className="w-72"
					value={action}
					onChange={(event) => {
						setAction(event.target.value);
						reset();
					}}
				/>
				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={platformOnly}
						onChange={(event) => {
							setPlatformOnly(event.target.checked);
							reset();
						}}
					/>
					<Trans>Platform entries only</Trans>
				</label>
			</PageHeader>
			{query.error ? (
				<ErrorNotice error={query.error} title={<Trans>Couldn't load the audit log</Trans>} />
			) : !query.data ? (
				<Skeleton className="h-64 rounded-xl" />
			) : (
				<>
					<div className="overflow-x-auto rounded-xl border border-line">
						<table className="w-full min-w-[760px] text-sm" data-testid="admin-audit-table">
							<thead className="bg-sunken text-xs text-ink-3">
								<tr>
									<th className="px-3 py-2 text-start font-medium">{t`When`}</th>
									<th className="px-3 py-2 text-start font-medium">{t`Action`}</th>
									<th className="px-3 py-2 text-start font-medium">{t`Organization`}</th>
									<th className="px-3 py-2 text-start font-medium">{t`Actor`}</th>
									<th className="px-3 py-2 text-start font-medium">{t`Details`}</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((entry) => (
									<tr key={entry.id} className="border-t border-line align-top">
										<td className="px-3 py-2 whitespace-nowrap text-ink-2">{formatDate(entry.createdAt)}</td>
										<td className="px-3 py-2 font-mono text-xs">{entry.action}</td>
										<td className="px-3 py-2">{entry.organizationName ?? t`Platform`}</td>
										<td className="px-3 py-2 font-mono text-xs">
											{entry.actorUserId ?? "-"}
											{entry.impersonatorUserId ? ` (support: ${entry.impersonatorUserId})` : ""}
										</td>
										<td className="px-3 py-2 font-mono text-xs break-all text-ink-2">
											{entry.targetType ? `${entry.targetType}:${entry.targetId ?? ""} ` : ""}
											{Object.keys(entry.metadata).length > 0 ? JSON.stringify(entry.metadata) : ""}
										</td>
									</tr>
								))}
								{rows.length === 0 && (
									<tr>
										<td colSpan={5} className="px-3 py-8 text-center text-ink-3">
											<Trans>No entries.</Trans>
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
					<div className="flex justify-end gap-2">
						<Button
							variant="secondary"
							size="sm"
							disabled={cursors.length === 0}
							onClick={() => setCursors(cursors.slice(0, -1))}
						>
							<Trans>Newer</Trans>
						</Button>
						<Button
							variant="secondary"
							size="sm"
							disabled={rows.length < PAGE}
							onClick={() => {
								const last = rows.at(-1);
								if (last) setCursors([...cursors, last.id]);
							}}
						>
							<Trans>Older</Trans>
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
