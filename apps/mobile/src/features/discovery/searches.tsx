import type { SearchSource } from "./search-form";
import type { WatchedRun } from "@careeros/discovery-form";
import { pollDelay, RESUME_SCHEDULE, startWatching, viewRuns } from "@careeros/discovery-form";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { scheduleLabels } from "./messages";
import { SearchForm } from "./search-form";
import { client, orpc } from "@/api/client";
import { useSession } from "@/auth/session";
import { entitlementErrorMessage } from "@/features/organization/entitlement-message";
import { useEntitlements } from "@/features/organization/entitlements";
import { Banner, Button, Card, ConfirmDialog, EmptyState, showToast, Skeleton, Text, useTheme } from "@/ui";

// CAREEROS (P4-T03): the "Searches" section above the review queue, the twin of
// apps/web/src/features/discovery/searches.tsx. The server is the guard on every call; the plan gate only decides
// what the screen shows.

export function SearchesSection() {
	const { t } = useLingui();
	const { space } = useTheme();
	const session = useSession();
	const entitlements = useEntitlements();
	const inPlan = entitlements.data?.features.job_discovery === true;
	const showAi = entitlements.data?.features.platform_ai === true;
	const [editing, setEditing] = useState<SearchSource | "new" | null>(null);
	const query = useQuery({
		...orpc.discovery.sources.list.queryOptions(),
		enabled: session.status === "signed-in",
		retry: false,
		queryKey: [...orpc.discovery.sources.key(), session.server],
	});
	const sources = query.data ?? [];

	return (
		<View style={{ gap: space.s3 }}>
			<Text variant="title" accessibilityRole="header">
				{t`Searches`}
			</Text>
			<Text color="ink3">
				{t`A search looks at the job boards you choose, on a schedule, and adds postings that match to the queue below.`}
			</Text>

			{!entitlements.isPending && !inPlan ? (
				<Banner
					tone="info"
					icon="lock"
					message={t`Your plan doesn't include job discovery. Ask your administrator about upgrading.`}
				/>
			) : null}

			{inPlan && sources.length > 0 && editing === null ? (
				<Button label={t`New search`} onPress={() => setEditing("new")} />
			) : null}

			{inPlan && editing !== null ? (
				<SearchForm
					key={editing === "new" ? "new" : editing.id}
					source={editing === "new" ? undefined : editing}
					showAi={showAi}
					onClose={() => setEditing(null)}
				/>
			) : null}

			{query.isPending && inPlan ? <Skeleton height={space.s12 * 2} /> : null}
			{query.isError && inPlan ? (
				<Banner
					tone="danger"
					message={t`Couldn't load your searches. Check your connection and try again.`}
					action={{ label: t`Retry`, onPress: () => void query.refetch() }}
				/>
			) : null}
			{!query.isPending && !query.isError && sources.length === 0 && inPlan && editing === null ? (
				<EmptyState
					title={t`No searches yet`}
					message={t`Add one with the job titles, skills and places you want, plus the company job boards to watch. It runs on its own, and the best matches show up in the queue.`}
					action={{ label: t`New search`, onPress: () => setEditing("new") }}
				/>
			) : null}
			{sources.map((source) => (
				<SearchRow
					key={source.id}
					source={source}
					readOnly={!inPlan}
					onEdit={() => setEditing(source)}
					onDeleted={() => setEditing((current) => (current !== "new" && current?.id === source.id ? null : current))}
				/>
			))}
		</View>
	);
}

export type SearchRowProps = {
	source: SearchSource;
	readOnly: boolean;
	onEdit: () => void;
	onDeleted: () => void;
};

export function SearchRow({ source, readOnly, onEdit, onDeleted }: SearchRowProps) {
	const { t, i18n } = useLingui();
	const { space } = useTheme();
	const session = useSession();
	const queryClient = useQueryClient();
	const [watching, setWatching] = useState<WatchedRun | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const runs = useQuery({
		...orpc.discovery.runs.list.queryOptions({ input: { jobSourceId: source.id } }),
		enabled: session.status === "signed-in",
		retry: false,
		queryKey: [...orpc.discovery.runs.key(), session.server, source.id],
		refetchInterval: (query) => pollDelay(query.state.data, watching, Date.now()),
	});
	const { latest, followed, running, finished } = viewRuns(runs.data, watching);

	const refreshAll = () => {
		void queryClient.invalidateQueries({ queryKey: orpc.discovery.sources.key() });
		void queryClient.invalidateQueries({ queryKey: orpc.discovery.runs.key() });
		void queryClient.invalidateQueries({ queryKey: orpc.discovery.jobs.key() });
	};

	// The run finished: say so once and refresh the lists.
	const announced = useRef<string>(undefined);
	useEffect(() => {
		if (!finished || !followed || announced.current === followed.runId) return;
		announced.current = followed.runId;
		void queryClient.invalidateQueries({ queryKey: orpc.discovery.sources.key() });
		void queryClient.invalidateQueries({ queryKey: orpc.discovery.jobs.key() });
		if (followed.status === "failed") showToast({ message: t`The run of "${source.name}" failed.` });
		else {
			const found = followed.new;
			showToast({ message: t`The run of "${source.name}" finished: ${found} new.` });
		}
	}, [finished, followed, queryClient, source.name, t]);

	const attempt = async (operation: () => Promise<unknown>, failed: (error: unknown) => string, done?: () => void) => {
		if (busy) return;
		setBusy(true);
		try {
			await operation();
			done?.();
		} catch (error) {
			showToast({ message: entitlementErrorMessage(error) ?? failed(error) });
		} finally {
			setBusy(false);
		}
	};
	const runNow = () =>
		attempt(
			async () => {
				const summary = await client.discovery.runNow({ jobSourceId: source.id });
				setWatching(startWatching(summary.runId));
				void runs.refetch();
			},
			(error) =>
				(error as { code?: string } | null)?.code === "TOO_MANY_REQUESTS"
					? t`You can run a search by hand once every 10 minutes.`
					: t`Couldn't start the run. Try again.`,
		);
	const paused = source.schedule === "paused";
	const togglePause = () =>
		attempt(
			() => client.discovery.sources.update({ id: source.id, schedule: paused ? RESUME_SCHEDULE : "paused" }),
			() => t`Couldn't change the schedule. Try again.`,
			refreshAll,
		);
	const remove = () => {
		setConfirmingDelete(false);
		void attempt(
			() => client.discovery.sources.delete({ id: source.id }),
			() => t`Couldn't delete this search. Try again.`,
			() => {
				showToast({ message: t`Search deleted` });
				refreshAll();
				onDeleted();
			},
		);
	};

	const schedule = scheduleLabels();
	const date = (value: Date | string) => i18n.date(new Date(value), { dateStyle: "medium", timeStyle: "short" });
	const where = [...source.titles.slice(0, 3), ...source.locations.slice(0, 2)].join(" · ");
	const status = running
		? t`Running`
		: !latest
			? null
			: latest.status === "failed"
				? t`Failed`
				: latest.status === "partial"
					? t`Finished with errors`
					: t`Finished`;

	return (
		<Card style={{ gap: space.s2 }}>
			<Text variant="title">{source.name}</Text>
			{where ? <Text color="ink2">{where}</Text> : null}
			<Text color="ink3">{`${schedule[source.schedule]}${status ? ` · ${status}` : ""}`}</Text>
			<Text color="ink2">
				{paused || !source.nextRunAt ? t`Next run: paused` : t`Next run: ${date(source.nextRunAt)}`}
			</Text>
			<Text color="ink2">
				{latest ? t`Last run: ${date(latest.finishedAt ?? latest.startedAt)}` : t`Last run: not run yet`}
			</Text>
			{latest ? <Text color="ink2">{t`New jobs in the last run: ${latest.new}`}</Text> : null}
			{!readOnly ? (
				<View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.s2 }}>
					<Button
						size="sm"
						label={running ? t`Running` : t`Run now`}
						loading={running}
						disabled={busy || running}
						onPress={() => {
							void runNow();
						}}
					/>
					<Button
						size="sm"
						variant="secondary"
						label={paused ? t`Resume` : t`Pause`}
						disabled={busy}
						onPress={() => {
							void togglePause();
						}}
					/>
					<Button size="sm" variant="secondary" label={t`Edit`} disabled={busy} onPress={onEdit} />
					<Button
						size="sm"
						variant="ghost"
						label={t`Delete`}
						disabled={busy}
						onPress={() => setConfirmingDelete(true)}
					/>
				</View>
			) : null}
			<ConfirmDialog
				open={confirmingDelete}
				title={t`Delete "${source.name}"?`}
				message={t`The search and its run history are deleted. Jobs it already found stay in your queue.`}
				confirmLabel={t`Delete`}
				destructive
				onConfirm={remove}
				onCancel={() => setConfirmingDelete(false)}
			/>
		</Card>
	);
}
