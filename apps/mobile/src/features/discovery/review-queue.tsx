import type { RouterOutput } from "@/api/client";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import { useState } from "react";
import { View } from "react-native";
// CAREEROS (P4-T03): the searches section above the queue
import { SearchesSection } from "./searches";
import { client, orpc } from "@/api/client";
import { useSession } from "@/auth/session";
import { useCareerAction } from "@/features/career/hooks";
import { LoadState } from "@/features/career/shared";
import { routes } from "@/routes";
import { Button, Card, EmptyState, Screen, Segmented, Text, showToast, useTheme } from "@/ui";

// CAREEROS (P4-T02): the discovery review queue, the twin of apps/web/src/features/discovery/review-queue.tsx.
type DiscoveredJob = RouterOutput["discovery"]["jobs"]["list"][number];
type Status = "new" | "accepted" | "dismissed";

const PAGE = 25;
const scoreOf = (job: DiscoveredJob) => Math.round(job.aiScore ?? job.localScore);

/** The jobs the automations found, best match first: save one to the tracker, or dismiss it for good. */
export function JobsScreen() {
	const { t } = useLingui();
	const { space } = useTheme();
	const router = useRouter();
	const session = useSession();
	const [status, setStatus] = useState<Status>("new");
	const [limit, setLimit] = useState(PAGE);
	const [busyId, setBusyId] = useState<string>();
	const action = useCareerAction();
	const query = useQuery({
		...orpc.discovery.jobs.list.queryOptions({ input: { status, limit, offset: 0 } }),
		enabled: session.status === "signed-in",
		retry: false,
		queryKey: [...orpc.discovery.jobs.key(), session.server, status, limit],
	});
	const jobs = query.data ?? [];
	const finish = async () => {
		await Promise.all([query.refetch(), action.refresh()]);
	};
	const accept = (job: DiscoveredJob) => {
		setBusyId(job.id);
		void action
			.run(
				() => client.discovery.jobs.accept({ id: job.id }),
				() => showToast({ message: t`Saved to your applications` }),
			)
			.finally(() => {
				setBusyId(undefined);
				void finish();
			});
	};
	const dismiss = (job: DiscoveredJob) => {
		setBusyId(job.id);
		void action
			.run(() => client.discovery.jobs.dismiss({ id: job.id }))
			.finally(() => {
				setBusyId(undefined);
				void finish();
			});
	};

	return (
		<Screen onRefresh={() => query.refetch()}>
			<SearchesSection />
			<Text variant="title" accessibilityRole="header">
				{t`Jobs found for you`}
			</Text>
			<Text color="ink3">{t`Postings your automations found, best match first. Save one to your applications, or dismiss it and it never comes back.`}</Text>
			<Segmented
				label={t`Show jobs`}
				value={status}
				options={[
					{ value: "new", label: t`New` },
					{ value: "accepted", label: t`Saved` },
					{ value: "dismissed", label: t`Dismissed` },
				]}
				onChange={(value) => {
					setStatus(value);
					setLimit(PAGE);
				}}
			/>
			<LoadState query={query} />
			{action.error ? <Text color="danger">{action.error}</Text> : null}
			{!query.isPending && !query.isError && !jobs.length ? (
				<EmptyState
					title={
						status === "new"
							? t`Nothing to review`
							: status === "accepted"
								? t`No saved jobs yet`
								: t`No dismissed jobs`
					}
					message={t`New postings show up here after an automation runs.`}
				/>
			) : null}
			{jobs.map((job) => (
				<Card key={job.id} style={{ gap: space.s2 }}>
					<Text variant="title">{job.title}</Text>
					<Text color="ink2">{[job.company, job.location].filter(Boolean).join(" · ")}</Text>
					<Text color="ink3">{job.aiScore === null ? t`Match ${scoreOf(job)} (quick)` : t`Match ${scoreOf(job)}`}</Text>
					{job.aiSummary ? <Text>{job.aiSummary}</Text> : null}
					<View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.s2 }}>
						{job.status === "new" ? (
							<>
								<Button
									size="sm"
									label={t`Save to applications`}
									loading={busyId === job.id && action.pending}
									disabled={action.pending}
									onPress={() => accept(job)}
								/>
								<Button
									size="sm"
									variant="ghost"
									label={t`Dismiss`}
									disabled={action.pending}
									onPress={() => dismiss(job)}
								/>
							</>
						) : null}
						{job.status === "accepted" && job.applicationId ? (
							<Button
								size="sm"
								variant="secondary"
								label={t`Open application`}
								onPress={() => router.push(routes.application(job.applicationId ?? ""))}
							/>
						) : null}
						<Button
							size="sm"
							variant="ghost"
							label={t`Read posting`}
							onPress={() => {
								if (/^https?:\/\//i.test(job.url))
									void openBrowserAsync(job.url).catch(() =>
										showToast({ message: t`Couldn't open the posting. Try again.` }),
									);
							}}
						/>
					</View>
				</Card>
			))}
			{jobs.length >= limit ? (
				<Button variant="secondary" label={t`Show more`} onPress={() => setLimit(limit + PAGE)} />
			) : null}
		</Screen>
	);
}
