import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { RequireOrgAdmin } from "./access";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { orpc } from "@/libs/orpc/client";

const ACTION = /^[a-z][a-z0-9_.]{1,63}$/;

/** CAREEROS (P3-T08): Settings → Audit log. Newest first, optionally one action, a page at a time. */
export function AuditSettings() {
	return (
		<>
			<PageHeader
				title={<Trans>Audit log</Trans>}
				description={<Trans>Who changed what in your organization.</Trans>}
			/>
			<RequireOrgAdmin>
				<AuditBody />
			</RequireOrgAdmin>
		</>
	);
}

function AuditBody() {
	const actionId = useId();
	const [draft, setDraft] = useState("");
	const action = ACTION.test(draft.trim()) ? draft.trim() : undefined;
	const query = useInfiniteQuery(
		orpc.organization.audit.infiniteOptions({
			input: (cursor: string | undefined) => ({
				limit: 50,
				...(cursor ? { cursor } : {}),
				...(action ? { action } : {}),
			}),
			initialPageParam: undefined as string | undefined,
			getNextPageParam: (last) => last.nextCursor ?? undefined,
		}),
	);
	const items = query.data?.pages.flatMap((page) => page.items) ?? [];

	return (
		<SettingsSection title={<Trans>Entries</Trans>}>
			<div className="grid max-w-xs gap-1.5">
				<Label htmlFor={actionId}>
					<Trans>Action</Trans>
				</Label>
				<Input
					id={actionId}
					value={draft}
					placeholder={t`cohort.created`}
					maxLength={64}
					onChange={(event) => setDraft(event.target.value)}
				/>
			</div>
			{query.isLoading ? (
				<Skeleton className="h-40 rounded-xl" />
			) : items.length === 0 ? (
				<p className="rounded-xl border border-dashed border-line-2 p-4 text-sm text-ink-2">
					<Trans>No entries.</Trans>
				</p>
			) : (
				<ul className="divide-y divide-line overflow-hidden rounded-xl outline outline-line" data-testid="audit-list">
					{items.map((entry) => (
						<li key={entry.id} className="grid gap-0.5 p-3 text-sm">
							<span className="font-medium">{entry.action}</span>
							<span className="text-[13px] text-ink-3">
								{entry.createdAt.toLocaleString()}
								{entry.targetType ? ` · ${entry.targetType}${entry.targetId ? ` ${entry.targetId}` : ""}` : ""}
							</span>
						</li>
					))}
				</ul>
			)}
			{query.hasNextPage && (
				<div>
					<Button variant="secondary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
						<Trans>Load more</Trans>
					</Button>
				</div>
			)}
		</SettingsSection>
	);
}
