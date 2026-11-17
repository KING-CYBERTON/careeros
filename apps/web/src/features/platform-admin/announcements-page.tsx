import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { ErrorNotice, formatDate, notify } from "./shared";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P3-T07): platform announcements. A banner members see while it runs, plain text only, optionally for one
// plan or one organization. Each member can dismiss it for themselves.

/** `datetime-local` value (local time) for a date. */
function localValue(date: Date): string {
	const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
	return shifted.toISOString().slice(0, 16);
}

export function AnnouncementsPage() {
	const queryClient = useQueryClient();
	const list = useQuery(orpc.admin.announcements.list.queryOptions());
	const plans = useQuery(orpc.admin.plans.queryOptions());
	const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.admin.announcements.list.key() });
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [severity, setSeverity] = useState<"info" | "warning">("info");
	const [startsAt, setStartsAt] = useState(() => localValue(new Date()));
	const [endsAt, setEndsAt] = useState(() => localValue(new Date(Date.now() + 7 * 24 * 3_600_000)));
	const [planId, setPlanId] = useState("");
	const [organizationId, setOrganizationId] = useState("");

	const save = useMutation(
		orpc.admin.announcements.save.mutationOptions({
			onSuccess: async () => {
				notify.success(t`Announcement saved.`);
				setTitle("");
				setBody("");
				await refresh();
			},
			onError: (error: unknown) =>
				notify.error(getReadableErrorMessage(error, t`The announcement could not be saved.`)),
		}),
	);
	const end = useMutation(
		orpc.admin.announcements.end.mutationOptions({
			onSuccess: async () => {
				notify.success(t`Announcement ended.`);
				await refresh();
			},
			onError: (error: unknown) =>
				notify.error(getReadableErrorMessage(error, t`The announcement could not be ended.`)),
		}),
	);
	const valid =
		title.trim().length > 0 && body.trim().length > 0 && new Date(endsAt).getTime() > new Date(startsAt).getTime();
	// The time of the last fetch, so rendering stays pure; each refresh re-evaluates what is running.
	const now = list.dataUpdatedAt;

	return (
		<div className="grid gap-6">
			<PageHeader
				title={<Trans>Announcements</Trans>}
				description={<Trans>A banner every matching member sees until it ends.</Trans>}
			/>

			<SettingsSection title={<Trans>New announcement</Trans>}>
				<form
					className="grid max-w-xl gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate({
							title: title.trim(),
							body: body.trim(),
							severity,
							startsAt: new Date(startsAt),
							endsAt: new Date(endsAt),
							planId: planId || null,
							organizationId: organizationId.trim() || null,
						});
					}}
				>
					<div className="grid gap-1.5">
						<Label htmlFor="announcement-title">{t`Title`}</Label>
						<Input
							id="announcement-title"
							maxLength={120}
							value={title}
							onChange={(event) => setTitle(event.target.value)}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="announcement-body">{t`Message (plain text, up to 1,000 characters)`}</Label>
						<Textarea
							id="announcement-body"
							maxLength={1000}
							value={body}
							onChange={(event) => setBody(event.target.value)}
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<Label htmlFor="announcement-severity">{t`Kind`}</Label>
							<NativeSelect
								id="announcement-severity"
								value={severity}
								onChange={(event) => setSeverity(event.target.value as typeof severity)}
							>
								<option value="info">{t`Information`}</option>
								<option value="warning">{t`Warning`}</option>
							</NativeSelect>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="announcement-plan">{t`Only this plan`}</Label>
							<NativeSelect id="announcement-plan" value={planId} onChange={(event) => setPlanId(event.target.value)}>
								<option value="">{t`Every plan`}</option>
								{plans.data?.map((plan) => (
									<option key={plan.id} value={plan.id}>
										{plan.name}
									</option>
								))}
							</NativeSelect>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="announcement-start">{t`Starts`}</Label>
							<Input
								id="announcement-start"
								type="datetime-local"
								value={startsAt}
								onChange={(event) => setStartsAt(event.target.value)}
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="announcement-end">{t`Ends`}</Label>
							<Input
								id="announcement-end"
								type="datetime-local"
								value={endsAt}
								onChange={(event) => setEndsAt(event.target.value)}
							/>
						</div>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="announcement-org">{t`Only this organization (id, optional)`}</Label>
						<Input
							id="announcement-org"
							value={organizationId}
							onChange={(event) => setOrganizationId(event.target.value)}
						/>
					</div>
					<Button type="submit" loading={save.isPending} disabled={!valid} className="w-fit">
						{t`Publish announcement`}
					</Button>
				</form>
			</SettingsSection>

			<SettingsSection title={<Trans>Recent announcements</Trans>}>
				{list.error ? (
					<ErrorNotice error={list.error} title={<Trans>Couldn't load announcements</Trans>} />
				) : !list.data ? (
					<Skeleton className="h-32 rounded-xl" />
				) : (
					<ul className="grid gap-3" data-testid="admin-announcements">
						{list.data.map((row) => {
							const running = row.startsAt.getTime() <= now && row.endsAt.getTime() > now;
							return (
								<li
									key={row.id}
									className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line p-3"
								>
									<div className="grid min-w-0 gap-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium">{row.title}</span>
											<Badge variant={row.severity === "warning" ? "warn" : "info"}>{row.severity}</Badge>
											<Badge variant={running ? "accent" : "neutral"}>
												{running ? t`Running` : row.endsAt.getTime() <= now ? t`Ended` : t`Scheduled`}
											</Badge>
											{row.planId && <Badge variant="outline">{row.planId}</Badge>}
											{row.organizationId && <Badge variant="outline">{row.organizationId}</Badge>}
										</div>
										<p className="text-sm break-words whitespace-pre-wrap text-ink-2">{row.body}</p>
										<p className="text-xs text-ink-3">
											{formatDate(row.startsAt)} - {formatDate(row.endsAt)}
										</p>
									</div>
									{running && (
										<Button
											variant="secondary"
											size="sm"
											loading={end.isPending}
											onClick={() => end.mutate({ id: row.id })}
										>
											<Trans>End now</Trans>
										</Button>
									)}
								</li>
							);
						})}
						{list.data.length === 0 && <li className="text-sm text-ink-3">{t`None yet.`}</li>}
					</ul>
				)}
			</SettingsSection>
		</div>
	);
}
