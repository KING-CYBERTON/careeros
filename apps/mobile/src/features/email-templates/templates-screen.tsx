import type { TemplateEntry } from "./queries";
import type { TemplateDraft } from "./template-editor";
import { useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { getKindLabel, getSourceLabel } from "./labels";
import { useEmailTemplates, useRefreshEmailTemplates } from "./queries";
import { emptyDraft, TemplateEditor } from "./template-editor";
import { orpc } from "@/api/client";
import { getStageLabel } from "@/features/applications/stages";
import { useOrganizationAdmin } from "@/features/branding/access";
import { SettingsGroup, SettingsPage } from "@/features/settings/layout";
import { Banner, Button, ConfirmDialog, ListRow, showToast, Skeleton, Text, useTheme } from "@/ui";

// CAREEROS (P5-T04): Settings → Email templates. The member's own templates can be added, edited and archived here;
// the organization's defaults and the built-ins are listed read-only. Editing the organization's defaults is web only
// (docs/UPSTREAM_PATCHES.md, "Mobile parity gaps"), so an owner or admin is pointed to the web app for that.

const describe = (entry: TemplateEntry) =>
	[
		getKindLabel(entry.kind),
		getSourceLabel(entry.source),
		entry.stageCategories.map((stage) => getStageLabel(stage)).join(", "),
	]
		.filter(Boolean)
		.join(" · ");

const draftOf = (entry: TemplateEntry): TemplateDraft => ({
	kind: entry.kind,
	stageCategory: entry.stageCategories[0] ?? null,
	name: entry.name,
	subject: entry.subject,
	body: entry.body,
});

type Editing = { id: string | null; initial: TemplateDraft };

export function EmailTemplatesScreen() {
	const { t } = useLingui();
	const { space } = useTheme();
	const templates = useEmailTemplates();
	const refresh = useRefreshEmailTemplates();
	const admin = useOrganizationAdmin() === "allowed";
	const [editing, setEditing] = useState<Editing | null>(null);
	const [archiving, setArchiving] = useState<TemplateEntry | null>(null);

	const fail = (message: string) => () => showToast({ message });
	const done = (message: string) => async () => {
		setEditing(null);
		setArchiving(null);
		showToast({ message });
		await refresh();
	};
	const create = useMutation(
		orpc.emailTemplates.create.mutationOptions({
			onSuccess: done(t`Template saved`),
			onError: fail(t`Couldn't save the template. Try again.`),
		}),
	);
	const update = useMutation(
		orpc.emailTemplates.update.mutationOptions({
			onSuccess: done(t`Template saved`),
			onError: fail(t`Couldn't save the template. Try again.`),
		}),
	);
	const archive = useMutation(
		orpc.emailTemplates.archive.mutationOptions({
			onSuccess: done(t`Template archived`),
			onError: fail(t`Couldn't archive the template. Try again.`),
		}),
	);

	const entries = templates.entries ?? [];
	const mine = entries.filter((entry) => entry.source === "mine");
	const others = entries.filter((entry) => entry.source !== "mine");

	return (
		<SettingsPage title={t`Email templates`} onRefresh={() => templates.refetch()}>
			{templates.isPending ? (
				<Skeleton height={space.s12 * 3} />
			) : templates.isError ? (
				<Banner
					tone="danger"
					message={t`Your templates couldn't be loaded.`}
					action={{ label: t`Try again`, onPress: () => void templates.refetch() }}
				/>
			) : (
				<>
					<Text variant="callout" color="ink3">
						{t`Your own templates for writing to employers. They appear under Write email on every application.`}
					</Text>
					<SettingsGroup title={t`Your templates`}>
						{mine.length === 0 ? (
							<View style={{ padding: space.s4 }}>
								<Text color="ink2">{t`You have no templates of your own yet. You can also save one from Write email.`}</Text>
							</View>
						) : (
							mine.map((entry) => (
								<ListRow
									key={entry.id}
									title={entry.name}
									subtitle={`${describe(entry)}\n${entry.subject}`}
									chevron
									onPress={() => setEditing({ id: entry.id, initial: draftOf(entry) })}
								/>
							))
						)}
					</SettingsGroup>
					<Button
						fullWidth
						icon="plus"
						label={t`New template`}
						onPress={() => setEditing({ id: null, initial: emptyDraft() })}
					/>
					{others.length > 0 ? (
						<SettingsGroup
							title={t`Also available to you`}
							note={t`From your organization and the built-in set. You can't change these here.`}
						>
							{others.map((entry) => (
								<ListRow key={entry.id} title={entry.name} subtitle={`${describe(entry)}\n${entry.subject}`} />
							))}
						</SettingsGroup>
					) : null}
					{admin ? (
						<Banner
							tone="info"
							icon="globe"
							message={t`Owners and admins edit the organization's templates in the web app, under Settings.`}
						/>
					) : null}
				</>
			)}

			<TemplateEditor
				open={editing !== null}
				onClose={() => setEditing(null)}
				title={editing?.id ? t`Edit template` : t`New template`}
				initial={editing?.initial ?? emptyDraft()}
				saving={create.isPending || update.isPending}
				onArchive={
					editing?.id
						? () => {
								const entry = mine.find((item) => item.id === editing.id);
								if (!entry) return;
								setEditing(null);
								setArchiving(entry);
							}
						: undefined
				}
				onSave={(draft) => (editing?.id ? update.mutate({ id: editing.id, ...draft }) : create.mutate(draft))}
			/>
			<ConfirmDialog
				open={archiving !== null}
				title={t`Archive ${archiving?.name ?? ""}?`}
				message={t`It leaves your list. Emails you already sent are not affected.`}
				confirmLabel={t`Archive`}
				destructive
				onConfirm={() => archiving && archive.mutate({ id: archiving.id })}
				onCancel={() => setArchiving(null)}
			/>
		</SettingsPage>
	);
}
