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
import { RequireOrgAdmin } from "@/features/org-admin/access";
import { SettingsSection } from "@/features/settings/section";
import { useConfirm } from "@/hooks/use-confirm";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P5-T04): Org admin console → Email templates. The templates every member of the organization sees. A
// built-in is customised by starting from its text; archiving a customised one brings the built-in back.

/** `id` is the default being edited; null creates a new one (from the built-in text, or from nothing). */
type Editing = { id: string | null; initial: TemplateDraft };

const draftOf = (entry: TemplateEntry): TemplateDraft => ({
	kind: entry.kind,
	stageCategory: entry.stageCategories[0] ?? null,
	name: entry.name,
	subject: entry.subject,
	body: entry.body,
});

export function OrgEmailTemplatesSettings() {
	return (
		<>
			<PageHeader
				title={<Trans>Organization email templates</Trans>}
				description={
					<Trans>
						The templates your members see under Write email. Customise one to replace the built-in text for everyone.
					</Trans>
				}
			/>
			<RequireOrgAdmin>
				<OrgTemplateList />
			</RequireOrgAdmin>
		</>
	);
}

function OrgTemplateList() {
	const templates = useEmailTemplates();
	const refresh = useRefreshEmailTemplates();
	const confirm = useConfirm();
	const [editing, setEditing] = useState<Editing | null>(null);

	const fail = (fallback: string) => (error: unknown) =>
		toast.add({ type: "error", description: getReadableErrorMessage(error, fallback) });
	const saved = async () => {
		setEditing(null);
		toast.add({ description: t`Template saved` });
		await refresh();
	};
	const create = useMutation(
		orpc.emailTemplates.orgCreate.mutationOptions({
			onSuccess: saved,
			onError: fail(t`Couldn't save the template. Try again.`),
		}),
	);
	const update = useMutation(
		orpc.emailTemplates.orgUpdate.mutationOptions({
			onSuccess: saved,
			onError: fail(t`Couldn't save the template. Try again.`),
		}),
	);
	const archive = useMutation(
		orpc.emailTemplates.orgArchive.mutationOptions({
			onSuccess: async () => {
				toast.add({ description: t`Template archived` });
				await refresh();
			},
			onError: fail(t`Couldn't archive the template. Try again.`),
		}),
	);

	// The admin's own templates are theirs alone and belong on their own settings page, not in this list.
	const entries = (templates.entries ?? []).filter((entry) => entry.source !== "mine");

	return (
		<SettingsSection
			title={<Trans>Templates</Trans>}
			action={
				<Button size="sm" onClick={() => setEditing({ id: null, initial: emptyDraft() })}>
					<Trans>New template</Trans>
				</Button>
			}
		>
			{templates.isPending ? (
				<Skeleton className="h-32 rounded-xl" />
			) : templates.isError ? (
				<div role="alert" className="grid justify-items-start gap-2 text-sm text-ink-2">
					<p>
						<Trans>The templates couldn't be loaded.</Trans>
					</p>
					<Button size="sm" variant="secondary" onClick={() => void templates.refetch()}>
						<Trans>Try again</Trans>
					</Button>
				</div>
			) : (
				<ul className="divide-y divide-line overflow-hidden rounded-xl outline outline-line">
					{entries.map((entry) => (
						<TemplateRow key={entry.id} entry={entry}>
							{entry.source === "builtin" ? (
								<Button
									size="sm"
									variant="ghost"
									aria-label={t`Customise ${entry.name}`}
									onClick={() => setEditing({ id: null, initial: draftOf(entry) })}
								>
									<Trans>Customise</Trans>
								</Button>
							) : (
								<>
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
												description: t`Members see the built-in template again instead.`,
												confirmText: t`Archive`,
											}).then((yes) => yes && archive.mutate({ id: entry.id }))
										}
									>
										<Trans>Archive</Trans>
									</Button>
								</>
							)}
						</TemplateRow>
					))}
				</ul>
			)}

			<TemplateEditor
				open={editing !== null}
				onOpenChange={(open) => !open && setEditing(null)}
				title={editing?.id ? <Trans>Edit template</Trans> : <Trans>New template</Trans>}
				description={<Trans>Every member of your organization sees this template.</Trans>}
				initial={editing?.initial ?? emptyDraft()}
				saveLabel={<Trans>Save template</Trans>}
				saving={create.isPending || update.isPending}
				onSave={(draft) => (editing?.id ? update.mutate({ id: editing.id, ...draft }) : create.mutate(draft))}
			/>
		</SettingsSection>
	);
}
