import type { EmailTemplateKind } from "@careeros/email-templates";
import type { ApplicationStatus } from "@reactive-resume/schema/applications/data";
import { MAX_BODY_LENGTH, MAX_NAME_LENGTH, MAX_SUBJECT_LENGTH, TEMPLATE_KINDS } from "@careeros/email-templates";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { View } from "react-native";
import { STAGES } from "@reactive-resume/schema/applications/data";
import { getKindLabel } from "./labels";
import { getStageLabel } from "@/features/applications/stages";
import { Button, SelectSheet, Sheet, Text, TextArea, TextField, useTheme } from "@/ui";

// CAREEROS (P5-T04): the form that writes one of the member's own email templates, the twin of the web template editor.
// It holds the draft; the caller saves it. The limits come from `@careeros/email-templates`, the ones the API checks.

export type TemplateDraft = {
	kind: EmailTemplateKind;
	stageCategory: ApplicationStatus | null;
	name: string;
	subject: string;
	body: string;
};

export const emptyDraft = (): TemplateDraft => ({
	kind: "custom",
	stageCategory: null,
	name: "",
	subject: "",
	body: "",
});

type TemplateEditorProps = {
	open: boolean;
	onClose: () => void;
	title: string;
	description?: string | undefined;
	/** The draft the form starts from each time it opens. */
	initial: TemplateDraft;
	saving: boolean;
	onSave: (draft: TemplateDraft) => void;
	/** Shown as an "Archive template" button when the draft is an existing template. */
	onArchive?: (() => void) | undefined;
};

export function TemplateEditor({
	open,
	onClose,
	title,
	description,
	initial,
	saving,
	onSave,
	onArchive,
}: TemplateEditorProps) {
	return (
		<Sheet open={open} onClose={onClose} title={title} dismissible={!saving} detents={[0.9]}>
			{open ? (
				<EditorForm
					description={description}
					initial={initial}
					saving={saving}
					onClose={onClose}
					onSave={onSave}
					onArchive={onArchive}
				/>
			) : null}
		</Sheet>
	);
}

export type EditorFormProps = Pick<
	TemplateEditorProps,
	"description" | "initial" | "saving" | "onClose" | "onSave" | "onArchive"
>;

export function EditorForm({ description, initial, saving, onClose, onSave, onArchive }: EditorFormProps) {
	const { t } = useLingui();
	const { space } = useTheme();
	const [draft, setDraft] = useState(initial);
	const valid = draft.name.trim().length > 0 && draft.subject.trim().length > 0;
	const anyStage = "any";
	// Passed in as a value, so the double braces never reach the translators' message.
	const examples = "{{company}}, {{role}}, {{contactName}}";

	return (
		<View style={{ gap: space.s3 }}>
			{description ? (
				<Text variant="callout" color="ink3">
					{description}
				</Text>
			) : null}
			<TextField
				label={t`Name`}
				value={draft.name}
				maxLength={MAX_NAME_LENGTH}
				onChangeText={(name) => setDraft({ ...draft, name })}
			/>
			<SelectSheet
				label={t`Kind`}
				value={draft.kind}
				options={TEMPLATE_KINDS.map((value) => ({ value, label: getKindLabel(value) }))}
				onChange={(kind) => setDraft({ ...draft, kind })}
			/>
			<SelectSheet
				label={t`Suggested for`}
				value={draft.stageCategory ?? anyStage}
				options={[
					{ value: anyStage, label: t`Any stage` },
					...STAGES.map(({ value }) => ({ value, label: getStageLabel(value) })),
				]}
				onChange={(value) =>
					setDraft({ ...draft, stageCategory: value === anyStage ? null : (value as ApplicationStatus) })
				}
			/>
			<TextField
				label={t`Subject`}
				value={draft.subject}
				maxLength={MAX_SUBJECT_LENGTH}
				onChangeText={(subject) => setDraft({ ...draft, subject })}
			/>
			<TextArea
				label={t`Message`}
				value={draft.body}
				maxLength={MAX_BODY_LENGTH}
				minLines={8}
				helper={t`Put variables such as ${examples} where the details go.`}
				onChangeText={(body) => setDraft({ ...draft, body })}
			/>
			<Button
				fullWidth
				size="lg"
				label={t`Save template`}
				loading={saving}
				disabled={!valid}
				onPress={() => onSave({ ...draft, name: draft.name.trim(), subject: draft.subject.trim() })}
			/>
			<Button fullWidth variant="secondary" label={t`Cancel`} disabled={saving} onPress={onClose} />
			{onArchive ? (
				<Button fullWidth variant="ghost" label={t`Archive template`} disabled={saving} onPress={onArchive} />
			) : null}
		</View>
	);
}
