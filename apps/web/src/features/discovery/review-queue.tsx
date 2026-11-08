import type { RouterOutput } from "@/libs/orpc/client";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@reactive-resume/ui/components/tabs";
import { toast } from "@reactive-resume/ui/components/toast";
import { getOrpcErrorMessage, toastError } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P4-T02): the discovery review queue. The list comes back best match first (AI score, then local score).
type DiscoveredJob = RouterOutput["discovery"]["jobs"]["list"][number];
type Status = "new" | "accepted" | "dismissed";

const PAGE = 25;

const scoreOf = (job: DiscoveredJob) => Math.round(job.aiScore ?? job.localScore);

/** The queue of jobs the automations found: accept one into the tracker, or dismiss it for good. */
export function DiscoveryReviewQueue() {
	const queryClient = useQueryClient();
	const [status, setStatus] = useState<Status>("new");
	const [limit, setLimit] = useState(PAGE);
	const input = { status, limit, offset: 0 };
	const query = useQuery(orpc.discovery.jobs.list.queryOptions({ input }));

	const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.discovery.jobs.key() });
	const accept = useMutation(
		orpc.discovery.jobs.accept.mutationOptions({
			onSuccess: () => {
				toast.add({ type: "success", description: t`Saved to your applications.` });
				refresh();
				void queryClient.invalidateQueries({ queryKey: orpc.applications.key() });
			},
			onError: (error) => toastError(error, t`Couldn't save this job. Try again.`),
		}),
	);
	const dismiss = useMutation(
		orpc.discovery.jobs.dismiss.mutationOptions({
			onSuccess: refresh,
			onError: (error) => toastError(error, t`Couldn't dismiss this job. Try again.`),
		}),
	);

	const jobs = query.data ?? [];

	return (
		<section className="grid gap-4" aria-labelledby="discovery-queue-title">
			<div className="grid gap-1">
				<h2 id="discovery-queue-title" className="text-lg font-medium">
					<Trans>Jobs found for you</Trans>
				</h2>
				<p className="text-sm text-ink-2">
					<Trans>
						Postings your automations found, best match first. Save one to your applications, or dismiss it and it never
						comes back.
					</Trans>
				</p>
			</div>

			<Tabs
				value={status}
				onValueChange={(value) => {
					setStatus(value as Status);
					setLimit(PAGE);
				}}
			>
				<TabsList variant="line" aria-label={t`Show jobs`}>
					<TabsTrigger value="new">
						<Trans>New</Trans>
					</TabsTrigger>
					<TabsTrigger value="accepted">
						<Trans>Saved</Trans>
					</TabsTrigger>
					<TabsTrigger value="dismissed">
						<Trans>Dismissed</Trans>
					</TabsTrigger>
				</TabsList>
			</Tabs>

			{query.isPending ? (
				<Skeleton className="h-40 rounded-xl" />
			) : query.isError ? (
				<div
					role="alert"
					className="grid justify-items-start gap-2 rounded-xl border border-line p-4 text-sm text-ink-2"
				>
					<p>{getOrpcErrorMessage(query.error, { fallback: t`Couldn't load your jobs. Try again.` })}</p>
					<Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
						<Trans>Try again</Trans>
					</Button>
				</div>
			) : jobs.length === 0 ? (
				<p className="rounded-xl border border-line p-4 text-sm text-ink-2">
					{status === "new" ? (
						<Trans>Nothing to review. New postings show up here after an automation runs.</Trans>
					) : status === "accepted" ? (
						<Trans>No saved jobs yet.</Trans>
					) : (
						<Trans>No dismissed jobs.</Trans>
					)}
				</p>
			) : (
				<ul className="grid gap-3">
					{jobs.map((job) => (
						<li key={job.id} className="grid gap-2 rounded-xl border border-line p-4">
							<div className="flex flex-wrap items-start justify-between gap-2">
								<div className="grid min-w-0 gap-0.5">
									<a
										href={job.url}
										target="_blank"
										rel="noopener noreferrer"
										className="font-medium break-words hover:underline"
									>
										{job.title}
									</a>
									<p className="text-sm text-ink-2">{[job.company, job.location].filter(Boolean).join(" · ")}</p>
								</div>
								<Badge variant={job.aiScore === null ? "neutral" : "accent"}>
									{job.aiScore === null ? t`Match ${scoreOf(job)} (quick)` : t`Match ${scoreOf(job)}`}
								</Badge>
							</div>
							{job.aiSummary && <p className="text-sm">{job.aiSummary}</p>}
							<div className="flex flex-wrap items-center gap-2">
								{job.status === "new" && (
									<>
										<Button
											size="sm"
											loading={accept.isPending && accept.variables?.id === job.id}
											onClick={() => accept.mutate({ id: job.id })}
										>
											<Trans>Save to applications</Trans>
										</Button>
										<Button
											size="sm"
											variant="ghost"
											loading={dismiss.isPending && dismiss.variables?.id === job.id}
											onClick={() => dismiss.mutate({ id: job.id })}
										>
											<Trans>Dismiss</Trans>
										</Button>
									</>
								)}
								{job.status === "accepted" && job.applicationId && (
									<Link
										to="/dashboard/applications"
										search={{ applicationId: job.applicationId }}
										className="text-sm font-medium text-accent-text hover:underline"
									>
										<Trans>Open application</Trans>
									</Link>
								)}
							</div>
						</li>
					))}
				</ul>
			)}

			{jobs.length >= limit && (
				<Button variant="secondary" className="justify-self-start" onClick={() => setLimit(limit + PAGE)}>
					<Trans>Show more</Trans>
				</Button>
			)}
		</section>
	);
}
