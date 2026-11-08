import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Checkbox } from "@reactive-resume/ui/components/checkbox";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { RequireOrgAdmin } from "./access";
import { useAdminMembers, useCohorts } from "./queries";
import { PageHeader } from "@/components/layout/page-header";
import { getRoleLabel } from "@/features/organization/roles";
import { SettingsSection } from "@/features/settings/section";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

/** CAREEROS (P3-T08): Settings → Cohorts. Group the organization's members into classes or intakes. */
export function CohortsSettings() {
	return (
		<>
			<PageHeader
				title={<Trans>Cohorts</Trans>}
				description={<Trans>Group members into classes or intakes, then follow how each group is doing.</Trans>}
			/>
			<RequireOrgAdmin>
				<CreateCohort />
				<CohortList />
				<AssignMembers />
			</RequireOrgAdmin>
		</>
	);
}

function useRefreshCohorts() {
	const queryClient = useQueryClient();
	return () => queryClient.invalidateQueries({ queryKey: orpc.orgAdmin.key() });
}

function CreateCohort() {
	const nameId = useId();
	const startId = useId();
	const endId = useId();
	const [name, setName] = useState("");
	const [startsOn, setStartsOn] = useState("");
	const [endsOn, setEndsOn] = useState("");
	const refresh = useRefreshCohorts();
	const create = useMutation(
		orpc.orgAdmin.cohorts.create.mutationOptions({
			onSuccess: async (cohort) => {
				setName("");
				setStartsOn("");
				setEndsOn("");
				toast.add({ description: t`Created ${cohort.name}` });
				await refresh();
			},
			onError: (error) =>
				toast.add({
					type: "error",
					description: getReadableErrorMessage(error, t`Couldn't create the cohort. Try again.`),
				}),
		}),
	);
	return (
		<SettingsSection title={<Trans>New cohort</Trans>}>
			<form
				className="flex flex-wrap items-end gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					create.mutate({ name: name.trim(), startsOn: startsOn || null, endsOn: endsOn || null });
				}}
			>
				<div className="grid min-w-[200px] flex-1 gap-1.5">
					<Label htmlFor={nameId}>
						<Trans>Name</Trans>
					</Label>
					<Input id={nameId} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
				</div>
				<div className="grid gap-1.5">
					<Label htmlFor={startId}>
						<Trans>Starts</Trans>
					</Label>
					<Input id={startId} type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
				</div>
				<div className="grid gap-1.5">
					<Label htmlFor={endId}>
						<Trans>Ends</Trans>
					</Label>
					<Input id={endId} type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
				</div>
				<Button type="submit" disabled={create.isPending || name.trim() === ""}>
					<Trans>Create cohort</Trans>
				</Button>
			</form>
		</SettingsSection>
	);
}

function CohortList() {
	const archivedId = useId();
	const [showArchived, setShowArchived] = useState(false);
	const { data, isLoading } = useCohorts(showArchived);
	const refresh = useRefreshCohorts();
	const archive = useMutation(
		orpc.orgAdmin.cohorts.archive.mutationOptions({
			onSuccess: refresh,
			onError: (error) =>
				toast.add({
					type: "error",
					description: getReadableErrorMessage(error, t`Couldn't change the cohort. Try again.`),
				}),
		}),
	);
	const rename = useMutation(
		orpc.orgAdmin.cohorts.update.mutationOptions({
			onSuccess: refresh,
			onError: (error) =>
				toast.add({
					type: "error",
					description: getReadableErrorMessage(error, t`Couldn't rename the cohort. Try again.`),
				}),
		}),
	);
	return (
		<SettingsSection
			title={<Trans>Cohorts</Trans>}
			action={
				<div className="flex items-center gap-2 text-sm text-ink-2">
					<Checkbox
						id={archivedId}
						checked={showArchived}
						onCheckedChange={(checked) => setShowArchived(checked === true)}
					/>
					<Label htmlFor={archivedId}>
						<Trans>Show archived</Trans>
					</Label>
				</div>
			}
		>
			{isLoading ? (
				<Skeleton className="h-24 rounded-xl" />
			) : !data || data.length === 0 ? (
				<p className="rounded-xl border border-dashed border-line-2 p-4 text-sm text-ink-2">
					<Trans>No cohorts yet.</Trans>
				</p>
			) : (
				<ul className="divide-y divide-line overflow-hidden rounded-xl outline outline-line">
					{data.map((cohort) => (
						<li key={cohort.id} className="flex flex-wrap items-center gap-3 p-3" data-testid="cohort-row">
							<div className="grid min-w-0 flex-1">
								<span className="truncate text-sm font-medium">
									{cohort.name}
									{cohort.archivedAt && (
										<Badge className="ms-2">
											<Trans>Archived</Trans>
										</Badge>
									)}
								</span>
								<span className="truncate text-[13px] text-ink-3">
									{cohort.startsOn || cohort.endsOn ? `${cohort.startsOn ?? "…"} → ${cohort.endsOn ?? "…"} · ` : ""}
									<Trans>{cohort.memberCount} members</Trans>
								</span>
							</div>
							<Button
								size="sm"
								variant="ghost"
								aria-label={t`Rename ${cohort.name}`}
								onClick={() => {
									const next = window.prompt(t`New name for ${cohort.name}`, cohort.name)?.trim();
									if (next && next !== cohort.name) rename.mutate({ id: cohort.id, name: next });
								}}
							>
								<Trans>Rename</Trans>
							</Button>
							<Button
								size="sm"
								variant="ghost"
								aria-label={cohort.archivedAt ? t`Restore ${cohort.name}` : t`Archive ${cohort.name}`}
								onClick={() => archive.mutate({ id: cohort.id, archived: !cohort.archivedAt })}
							>
								{cohort.archivedAt ? <Trans>Restore</Trans> : <Trans>Archive</Trans>}
							</Button>
						</li>
					))}
				</ul>
			)}
		</SettingsSection>
	);
}

function AssignMembers() {
	const [page, setPage] = useState(1);
	const { data, isLoading } = useAdminMembers(page);
	const { data: cohorts } = useCohorts(false);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [target, setTarget] = useState("");
	const refresh = useRefreshCohorts();
	const move = useMutation(
		orpc.orgAdmin.members.setCohort.mutationOptions({
			onSuccess: async (result) => {
				setSelected(new Set());
				toast.add({ description: t`Moved ${result.updated} members` });
				await refresh();
			},
			onError: (error) =>
				toast.add({
					type: "error",
					description: getReadableErrorMessage(error, t`Couldn't move the members. Try again.`),
				}),
		}),
	);
	const items = data?.items ?? [];
	const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
	const toggle = (id: string, on: boolean) =>
		setSelected((current) => {
			const next = new Set(current);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});
	return (
		<SettingsSection
			title={<Trans>Assign members</Trans>}
			description={<Trans>Pick members, then move them to a cohort or take them out of theirs.</Trans>}
		>
			<div className="flex flex-wrap items-center gap-3">
				<NativeSelect
					aria-label={t`Move selected members to`}
					className="w-56"
					value={target}
					onChange={(event) => setTarget(event.target.value)}
				>
					<option value="">{t`No cohort`}</option>
					{cohorts?.map((cohort) => (
						<option key={cohort.id} value={cohort.id}>
							{cohort.name}
						</option>
					))}
				</NativeSelect>
				<Button
					disabled={selected.size === 0 || move.isPending}
					onClick={() => move.mutate({ memberIds: [...selected], cohortId: target === "" ? null : target })}
				>
					<Trans>Move {selected.size} selected</Trans>
				</Button>
			</div>
			{isLoading ? (
				<Skeleton className="h-32 rounded-xl" />
			) : (
				<ul className="divide-y divide-line overflow-hidden rounded-xl outline outline-line">
					{items.map((member) => (
						<li key={member.memberId} className="flex flex-wrap items-center gap-3 p-3" data-testid="assign-row">
							<Checkbox
								aria-label={t`Select ${member.name}`}
								checked={selected.has(member.memberId)}
								onCheckedChange={(checked) => toggle(member.memberId, checked === true)}
							/>
							<div className="grid min-w-0 flex-1">
								<span className="truncate text-sm font-medium">{member.name}</span>
								<span className="truncate text-[13px] text-ink-3">{member.email}</span>
							</div>
							<Badge>{getRoleLabel(member.role)}</Badge>
							<span className="w-32 truncate text-sm text-ink-2">{member.cohortName ?? t`No cohort`}</span>
						</li>
					))}
				</ul>
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
	);
}
