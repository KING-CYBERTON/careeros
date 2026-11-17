import type { EmailTemplateKind } from "@careeros/email-templates";
import type { ApplicationStatus } from "@reactive-resume/schema/applications/data";
import type { ReactNode } from "react";
import {
	MAX_BODY_LENGTH,
	MAX_NAME_LENGTH,
	MAX_SUBJECT_LENGTH,
	TEMPLATE_KINDS,
	VARIABLE_NAMES,
} from "@careeros/email-templates";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useId, useState } from "react";
import { STAGES } from "@reactive-resume/schema/applications/data";
import { Button } from "@reactive-resume/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "@reactive-resume/ui/components/dialog";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { getKindLabel } from "./labels";
import { getStageLabel } from "@/features/applications/stages";

// CAREEROS (P5-T04): the form that writes one email template, for a member's own and for an organization default. It
// holds the draft; the caller saves it. The limits come from `@careeros/email-templates`, the same ones the API checks.

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
	onOpenChange: (open: boolean) => void;
	title: ReactNode;
	description?: ReactNode;
	/** The draft the form starts from each time it opens. */
	initial: TemplateDraft;
	saveLabel: ReactNode;
	saving: boolean;
	onSave: (draft: TemplateDraft) => void;
};

export function TemplateEditor({
	open,
	onOpenChange,
	title,
	description,
	initial,
	saveLabel,
	saving,
	onSave,
}: TemplateEditorProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent closeLabel={t`Close`} className="sm:max-w-[560px]">
				<DialogTitle className="text-2xl leading-8">{title}</DialogTitle>
				<DialogDescription className={description ? "text-[13px] leading-[18px]" : "sr-only"}>
					{description ?? title}
				</DialogDescription>
				<TemplateForm initial={initial} saveLabel={saveLabel} saving={saving} onSave={onSave} />
			</DialogContent>
		</Dialog>
	);
}

type TemplateFormProps = Pick<TemplateEditorProps, "initial" | "saveLabel" | "saving" | "onSave">;

function TemplateForm({ initial, saveLabel, saving, onSave }: TemplateFormProps) {
	const ids = { name: useId(), kind: useId(), stage: useId(), subject: useId(), body: useId() };
	const [draft, setDraft] = useState(initial);
	const patch = (change: Partial<TemplateDraft>) => setDraft((current) => ({ ...current, ...change }));
	const valid = draft.name.trim() !== "" && draft.subject.trim() !== "";

	return (
		<form
			className="grid gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (valid && !saving) onSave({ ...draft, name: draft.name.trim(), subject: draft.subject.trim() });
			}}
		>
			<div className="grid gap-1.5">
				<Label htmlFor={ids.name}>
					<Trans>Name</Trans>
				</Label>
				<Input
					id={ids.name}
					value={draft.name}
					maxLength={MAX_NAME_LENGTH}
					onChange={(event) => patch({ name: event.target.value })}
				/>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="grid gap-1.5">
					<Label htmlFor={ids.kind}>
						<Trans>Kind</Trans>
					</Label>
					<NativeSelect
						id={ids.kind}
						value={draft.kind}
						onChange={(event) => patch({ kind: event.target.value as EmailTemplateKind })}
					>
						{TEMPLATE_KINDS.map((kind) => (
							<option key={kind} value={kind}>
								{getKindLabel(kind)}
							</option>
						))}
					</NativeSelect>
				</div>
				<div className="grid gap-1.5">
					<Label htmlFor={ids.stage}>
						<Trans>Suggested for</Trans>
					</Label>
					<NativeSelect
						id={ids.stage}
						value={draft.stageCategory ?? ""}
						onChange={(event) => patch({ stageCategory: (event.target.value || null) as ApplicationStatus | null })}
					>
						<option value="">{t`Any stage`}</option>
						{STAGES.map((stage) => (
							<option key={stage.value} value={stage.value}>
								{getStageLabel(stage.value)}
							</option>
						))}
					</NativeSelect>
				</div>
			</div>
			<div className="grid gap-1.5">
				<Label htmlFor={ids.subject}>
					<Trans>Subject</Trans>
				</Label>
				<Input
					id={ids.subject}
					value={draft.subject}
					maxLength={MAX_SUBJECT_LENGTH}
					onChange={(event) => patch({ subject: event.target.value })}
				/>
			</div>
			<div className="grid gap-1.5">
				<Label htmlFor={ids.body}>
					<Trans>Message</Trans>
				</Label>
				<Textarea
					id={ids.body}
					value={draft.body}
					maxLength={MAX_BODY_LENGTH}
					onChange={(event) => patch({ body: event.target.value })}
					className="min-h-[200px] px-3.5 py-3 text-sm leading-[22px]"
				/>
				<p className="text-xs text-ink-3">
					<Trans>
						Plain text. These are filled in from the application when you use the template, and show as [name] when
						there is nothing to fill in:
					</Trans>{" "}
					<span className="font-mono">{VARIABLE_NAMES.map((name) => `{{${name}}}`).join(" ")}</span>
				</p>
			</div>
			<DialogFooter>
				<Button type="submit" loading={saving} disabled={!valid}>
					{saveLabel}
				</Button>
			</DialogFooter>
		</form>
	);
}
