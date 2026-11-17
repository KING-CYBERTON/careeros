import type { SearchSource } from "./search-form";
import type { WatchedRun } from "@careeros/discovery-form";
import { pollDelay, RESUME_SCHEDULE, startWatching, viewRuns } from "@careeros/discovery-form";
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { SearchForm } from "./search-form";
import { scheduleLabels } from "./search-messages";
import { useConfirm } from "@/hooks/use-confirm";
import { getOrpcErrorMessage, toastError } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P4-T03): the "Searches" section above the review queue. A member creates, edits, pauses, runs and deletes
// their job searches (automations) here. The server is the guard on every call (plan feature, limits, ownership); the
// plan gate below only decides what the page shows.

const formatDate = (date: Date | string) =>
	new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));

export function DiscoverySearches() {
	const { flags } = useRouteContext({ strict: false });
	const inPlan = flags?.features?.job_discovery === true;
	const showAi = flags?.features?.platform_ai === true;
	const [editing, setEditing] = useState<SearchSource | "new" | null>(null);
	// The server refuses every discovery call without the feature. Asking anyway keeps the section honest if it ever
	// allows reading, and an error simply leaves the plan note.
	const query = useQuery({ ...orpc.discovery.sources.list.queryOptions(), retry: false });
	const sources = query.data ?? [];

	return (
		<section className="grid gap-4" aria-labelledby="discovery-searches-title">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="grid gap-1">
					<h2 id="discovery-searches-title" className="text-lg font-medium">
						<Trans>Searches</Trans>
					</h2>
					<p className="text-sm text-ink-2">
						<Trans>
							A search looks at the job boards you choose, on a schedule, and adds postings that match to the queue
							below.
						</Trans>
					</p>
				</div>
				{inPlan && editing === null && sources.length > 0 && (
					<Button onClick={() => setEditing("new")}>
						<Trans>New search</Trans>
					</Button>
				)}
			</div>

			{!inPlan && (
				<p role="status" className="rounded-xl border border-line p-4 text-sm text-ink-2">
					<Trans>Your plan doesn't include job discovery. Ask your administrator about upgrading.</Trans>
				</p>
			)}

			{inPlan && editing !== null && (
				<SearchForm
					key={editing === "new" ? "new" : editing.id}
					{...(editing === "new" ? {} : { source: editing })}
					showAi={showAi}
					onClose={() => setEditing(null)}
				/>
			)}

			{query.isPending && inPlan ? (
				<Skeleton className="h-24 rounded-xl" />
			) : query.isError ? (
				inPlan ? (
					<div
						role="alert"
						className="grid justify-items-start gap-2 rounded-xl border border-line p-4 text-sm text-ink-2"
					>
						<p>{getOrpcErrorMessage(query.error, { fallback: t`Couldn't load your searches. Try again.` })}</p>
						<Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
							<Trans>Try again</Trans>
						</Button>
					</div>
				) : null
			) : sources.length === 0 ? (
				inPlan && editing === null ? (
					<div className="grid justify-items-start gap-3 rounded-xl border border-line p-4">
						<p className="text-sm text-ink-2">
							<Trans>
								You have no searches yet. Add one with the job titles, skills and places you want, plus the company job
								boards to watch. It runs on its own, and the best matches show up in the queue.
							</Trans>
						</p>
						<Button onClick={() => setEditing("new")}>
							<Trans>New search</Trans>
						</Button>
					</div>
				) : null
			) : (
				<ul className="grid gap-3">
					{sources.map((source) => (
						<SearchRow
							key={source.id}
							source={source}
							readOnly={!inPlan}
							onEdit={() => setEditing(source)}
							onDeleted={() => editing !== "new" && editing?.id === source.id && setEditing(null)}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

type SearchRowProps = {
	source: SearchSource;
	readOnly: boolean;
	onEdit: () => void;
	onDeleted: () => void;
};

function SearchRow({ source, readOnly, onEdit, onDeleted }: SearchRowProps) {
	const queryClient = useQueryClient();
	const confirm = useConfirm();
	// The run being followed, and when to stop asking about it.
	const [watching, setWatching] = useState<WatchedRun | null>(null);
	const runs = useQuery({
		...orpc.discovery.runs.list.queryOptions({ input: { jobSourceId: source.id } }),
		retry: false,
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
		if (followed.status === "failed") toast.add({ type: "error", description: t`The run of "${source.name}" failed.` });
		else {
			const found = followed.new;
			toast.add({ type: "success", description: t`The run of "${source.name}" finished: ${found} new.` });
		}
	}, [finished, followed, queryClient, source.name]);

	const run = useMutation(
		orpc.discovery.runNow.mutationOptions({
			onSuccess: (summary) => {
				setWatching(startWatching(summary.runId));
				void runs.refetch();
			},
			onError: (error) => toastError(error, t`Couldn't start the run. Try again.`, { allowServerMessage: true }),
		}),
	);
	const setSchedule = useMutation(
		orpc.discovery.sources.update.mutationOptions({
			onSuccess: refreshAll,
			onError: (error) => toastError(error, t`Couldn't change the schedule. Try again.`),
		}),
	);
	const remove = useMutation(
		orpc.discovery.sources.delete.mutationOptions({
			onSuccess: () => {
				toast.add({ type: "success", description: t`Search deleted.` });
				refreshAll();
				onDeleted();
			},
			onError: (error) => toastError(error, t`Couldn't delete this search. Try again.`),
		}),
	);

	const paused = source.schedule === "paused";
	const busy = run.isPending || setSchedule.isPending || remove.isPending;
	const schedule = scheduleLabels();
	const where = [...source.titles.slice(0, 3), ...source.locations.slice(0, 2)].join(" · ");

	const status = running
		? { label: t`Running`, variant: "info" as const }
		: !latest
			? null
			: latest.status === "failed"
				? { label: t`Failed`, variant: "danger" as const }
				: latest.status === "partial"
					? { label: t`Finished with errors`, variant: "warn" as const }
					: { label: t`Finished`, variant: "accent" as const };

	return (
		<li className="grid gap-3 rounded-xl border border-line p-4">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="grid min-w-0 gap-0.5">
					<h3 className="font-medium break-words">{source.name}</h3>
					{where && <p className="text-sm text-ink-2">{where}</p>}
				</div>
				<div className="flex flex-wrap items-center gap-1.5">
					<Badge variant={paused ? "neutral" : "outline"}>{schedule[source.schedule]}</Badge>
					{status && <Badge variant={status.variant}>{status.label}</Badge>}
				</div>
			</div>

			<dl className="grid gap-x-6 gap-y-1 text-sm text-ink-2 sm:grid-cols-3">
				<div>
					<dt className="text-xs text-ink-3">
						<Trans>Next run</Trans>
					</dt>
					<dd>{paused || !source.nextRunAt ? <Trans>Paused</Trans> : formatDate(source.nextRunAt)}</dd>
				</div>
				<div>
					<dt className="text-xs text-ink-3">
						<Trans>Last run</Trans>
					</dt>
					<dd>{latest ? formatDate(latest.finishedAt ?? latest.startedAt) : <Trans>Not run yet</Trans>}</dd>
				</div>
				<div>
					<dt className="text-xs text-ink-3">
						<Trans>New jobs in the last run</Trans>
					</dt>
					<dd>{latest ? latest.new : "—"}</dd>
				</div>
			</dl>

			{!readOnly && (
				<div className="flex flex-wrap items-center gap-2">
					<Button
						size="sm"
						loading={run.isPending || running}
						disabled={busy || running}
						onClick={() => run.mutate({ jobSourceId: source.id })}
					>
						{running ? <Trans>Running</Trans> : <Trans>Run now</Trans>}
					</Button>
					<Button
						size="sm"
						variant="secondary"
						disabled={busy}
						onClick={() => setSchedule.mutate({ id: source.id, schedule: paused ? RESUME_SCHEDULE : "paused" })}
					>
						{paused ? <Trans>Resume</Trans> : <Trans>Pause</Trans>}
					</Button>
					<Button size="sm" variant="secondary" disabled={busy} onClick={onEdit}>
						<Trans>Edit</Trans>
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={async () => {
							const confirmed = await confirm(t`Delete "${source.name}"?`, {
								description: t`The search and its run history are deleted. Jobs it already found stay in your queue.`,
								confirmText: t`Delete`,
							});
							if (confirmed) remove.mutate({ id: source.id });
						}}
					>
						<Trans>Delete</Trans>
					</Button>
				</div>
			)}
		</li>
	);
}
