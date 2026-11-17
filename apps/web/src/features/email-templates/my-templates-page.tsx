import type { TemplateEntry } from "./queries";
import type { TemplateDraft } from "./template-editor";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { useEmailTemplates, useRefreshEmailTemplates } from "./queries";
import { emptyDraft, TemplateEditor } from "./template-editor";
import { TemplateRow } from "./template-row";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { useConfirm } from "@/hooks/use-confirm";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P5-T04): Settings → Email templates. The member's own templates for writing to employers, and a read-only
// look at the ones their organization and the product offer beside them.

type Editing = { id: string | null; initial: TemplateDraft };

const draftOf = (entry: TemplateEntry): TemplateDraft => ({
	kind: entry.kind,
	stageCategory: entry.stageCategories[0] ?? null,
	name: entry.name,
	subject: entry.subject,
	body: entry.body,
});

export function EmailTemplatesSettings() {
	const templates = useEmailTemplates();
	const refresh = useRefreshEmailTemplates();
	const confirm = useConfirm();
	const [editing, setEditing] = useState<Editing | null>(null);

	const fail = (fallback: string) => (error: unknown) =>
		toast.add({ type: "error", description: getReadableErrorMessage(error, fallback) });
	const create = useMutation(
		orpc.emailTemplates.create.mutationOptions({
			onSuccess: async () => {
				setEditing(null);
				toast.add({ description: t`Template saved` });
				await refresh();
			},
			onError: fail(t`Couldn't save the template. Try again.`),
		}),
	);
	const update = useMutation(
		orpc.emailTemplates.update.mutationOptions({
			onSuccess: async () => {
				setEditing(null);
				toast.add({ description: t`Template saved` });
				await refresh();
			},
			onError: fail(t`Couldn't save the template. Try again.`),
		}),
	);
	const archive = useMutation(
		orpc.emailTemplates.archive.mutationOptions({
			onSuccess: async () => {
				toast.add({ description: t`Template archived` });
				await refresh();
			},
			onError: fail(t`Couldn't archive the template. Try again.`),
		}),
	);

	const entries = templates.entries ?? [];
	const mine = entries.filter((entry) => entry.source === "mine");
	const others = entries.filter((entry) => entry.source !== "mine");

	return (
		<>
			<PageHeader
				title={<Trans>Email templates</Trans>}
				description={
					<Trans>
						Your own templates for writing to employers. They appear under Write email on every application.
					</Trans>
				}
			/>
			<SettingsSection
				title={<Trans>Your templates</Trans>}
				action={
					<Button size="sm" onClick={() => setEditing({ id: null, initial: emptyDraft() })}>
						<Trans>New template</Trans>
					</Button>
				}
			>
				{templates.isPending ? (
					<Skeleton className="h-24 rounded-xl" />
				) : templates.isError ? (
					<div role="alert" className="grid justify-items-start gap-2 text-sm text-ink-2">
						<p>
							<Trans>Your templates couldn't be loaded.</Trans>
						</p>
						<Button size="sm" variant="secondary" onClick={() => void templates.refetch()}>
							<Trans>Try again</Trans>
						</Button>
					</div>
				) : mine.length === 0 ? (
					<p className="rounded-xl border border-dashed border-line-2 p-4 text-sm text-ink-2">
						<Trans>You have no templates of your own yet. You can also save one from Write email.</Trans>
					</p>
				) : (
					<ul className="divide-y divide-line overflow-hidden rounded-xl outline outline-line">
						{mine.map((entry) => (
							<TemplateRow key={entry.id} entry={entry}>
								<Button
									size="sm"
									variant="ghost"
									aria-label={t`Edit ${entry.name}`}
									onClick={() => setEditing({ id: entry.id, initial: draftOf(entry) })}
								>
									<Trans>Edit</Trans>
								</Button>
								<Button
									size="sm"
									variant="ghost"
									aria-label={t`Archive ${entry.name}`}
									onClick={() =>
										void confirm(t`Archive ${entry.name}?`, {
											description: t`It leaves your list. Emails you already sent are not affected.`,
											confirmText: t`Archive`,
										}).then((yes) => yes && archive.mutate({ id: entry.id }))
									}
								>
									<Trans>Archive</Trans>
								</Button>
							</TemplateRow>
						))}
					</ul>
				)}
			</SettingsSection>

			{others.length > 0 && (
				<SettingsSection
					title={<Trans>Also available to you</Trans>}
					description={<Trans>From your organization and the built-in set. You can't change these here.</Trans>}
				>
					<ul className="divide-y divide-line overflow-hidden rounded-xl outline outline-line">
						{others.map((entry) => (
							<TemplateRow key={entry.id} entry={entry} />
						))}
					</ul>
				</SettingsSection>
			)}

			<TemplateEditor
				open={editing !== null}
				onOpenChange={(open) => !open && setEditing(null)}
				title={editing?.id ? <Trans>Edit template</Trans> : <Trans>New template</Trans>}
				initial={editing?.initial ?? emptyDraft()}
				saveLabel={<Trans>Save template</Trans>}
				saving={create.isPending || update.isPending}
				onSave={(draft) => (editing?.id ? update.mutate({ id: editing.id, ...draft }) : create.mutate(draft))}
			/>
		</>
	);
}
