import type { TemplateEntry } from "./queries";
import type { Application } from "@/features/applications/types";
import { MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH, templatesForStage } from "@careeros/email-templates";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Linking, View } from "react-native";
import { copyEmail, openInMailApp } from "./actions";
import { getKindLabel, getSourceLabel } from "./labels";
import { useEmailTemplates, useRefreshEmailTemplates } from "./queries";
import { EditorForm } from "./template-editor";
import { orpc } from "@/api/client";
import { useSession } from "@/auth/session";
import {
	Banner,
	Button,
	ListRow,
	SelectSheet,
	Sheet,
	showToast,
	Skeleton,
	Text,
	TextArea,
	TextField,
	useTheme,
} from "@/ui";

// CAREEROS (P5-T04): "Write email" in an application's workspace, the twin of the web sheet. Pick the template for the
// application's stage, read it filled in from the application, edit it, and send it from your own mail app or copy it.
// The platform never sends the email.

type WriteEmailSheetProps = { application: Application; open: boolean; onClose: () => void };

export function WriteEmailSheet({ application, open, onClose }: WriteEmailSheetProps) {
	const { t } = useLingui();
	return (
		<Sheet open={open} onClose={onClose} title={t`Write email`} detents={[0.92]}>
			{open ? <WriteEmailBody application={application} /> : null}
		</Sheet>
	);
}

type BodyProps = { application: Application };

function WriteEmailBody({ application }: BodyProps) {
	const { t, i18n } = useLingui();
	const { space } = useTheme();
	const { server } = useSession();
	const templates = useEmailTemplates();
	const refresh = useRefreshEmailTemplates();
	const [showAll, setShowAll] = useState(false);
	const [picked, setPicked] = useState<string | null>(null);
	// What the person typed over the filled-in text, for the template it was typed on. Another template starts afresh.
	const [edits, setEdits] = useState<{ id: string; subject?: string; body?: string } | null>(null);
	const [saving, setSaving] = useState(false);

	const entries = templates.entries ?? [];
	const suggested = templatesForStage(entries, application.status);
	// A stage with nothing suggested (Closed) shows every template.
	const options = showAll || suggested.length === 0 ? entries : suggested;
	const selected: TemplateEntry | undefined = options.find((entry) => entry.id === picked) ?? options[0];

	// A built-in is sent with the text the screen shows, so the preview is filled in in the person's language.
	const input = {
		templateId: selected?.id ?? "",
		applicationId: application.id,
		locale: i18n.locale,
		...(selected?.source === "builtin" ? { source: { subject: selected.subject, body: selected.body } } : {}),
	};
	const render = useQuery({
		...orpc.emailTemplates.render.queryOptions({ input }),
		queryKey: [...orpc.emailTemplates.render.queryOptions({ input }).queryKey, server],
		enabled: selected !== undefined,
		retry: false,
		staleTime: 0,
		gcTime: 0,
	});

	const edited = selected && edits?.id === selected.id ? edits : null;
	const subject = edited?.subject ?? render.data?.subject ?? "";
	const body = edited?.body ?? render.data?.body ?? "";
	const ready = selected !== undefined && render.data !== undefined;
	const to = render.data?.to ?? null;
	const unfilled = (render.data?.missing ?? []).some(
		(name) => subject.includes(`[${name}]`) || body.includes(`[${name}]`),
	);

	const edit = (patch: { subject?: string; body?: string }) => {
		if (selected) setEdits({ ...edited, ...patch, id: selected.id });
	};

	const deps = {
		openURL: (url: string) => Linking.openURL(url),
		canOpenURL: (url: string) => Linking.canOpenURL(url),
		setString: (text: string) => Clipboard.setStringAsync(text),
	};
	const copyFailed = () => showToast({ message: t`Couldn't copy. Select the text and copy it yourself.` });
	const copy = async () => {
		try {
			await copyEmail({ subject, body }, deps);
			showToast({ message: t`Email copied` });
		} catch {
			copyFailed();
		}
	};
	const openMail = async () => {
		try {
			const outcome = await openInMailApp({ to, subject, body }, deps);
			if (outcome === "copied-long")
				showToast({ message: t`This email is too long to open in your mail app, so it was copied instead.` });
			else if (outcome === "copied-unavailable")
				showToast({ message: t`No mail app could open it, so the email was copied instead.` });
		} catch {
			copyFailed();
		}
	};

	const create = useMutation(
		orpc.emailTemplates.create.mutationOptions({
			onSuccess: async () => {
				setSaving(false);
				showToast({ message: t`Saved to your templates` });
				await refresh();
			},
			onError: () => showToast({ message: t`Couldn't save the template. Try again.` }),
		}),
	);

	// A sheet inside a sheet is awkward on a phone, so saving swaps this one's content for the form.
	if (saving && selected)
		return (
			<EditorForm
				description={t`It is saved as it reads now. To reuse it for other applications, put the variables back where the details are.`}
				initial={{
					kind: selected.kind,
					stageCategory: selected.stageCategories[0] ?? null,
					name: selected.source === "mine" ? selected.name : t`${selected.name} (mine)`,
					subject,
					body,
				}}
				saving={create.isPending}
				onClose={() => setSaving(false)}
				onSave={(draft) => create.mutate(draft)}
			/>
		);
	if (templates.isPending) return <Skeleton height={space.s12 * 3} />;
	if (templates.isError)
		return (
			<Banner
				tone="danger"
				message={t`The templates couldn't be loaded.`}
				action={{ label: t`Try again`, onPress: () => void templates.refetch() }}
			/>
		);

	return (
		<View style={{ gap: space.s3 }}>
			<Text variant="callout" color="ink2">
				{application.role} · {application.company}
			</Text>
			<SelectSheet
				label={t`Template`}
				value={selected?.id ?? null}
				options={options.map((entry) => ({
					value: entry.id,
					label: `${entry.name} · ${getKindLabel(entry.kind)} · ${getSourceLabel(entry.source)}`,
				}))}
				onChange={setPicked}
			/>
			{suggested.length > 0 && suggested.length < entries.length ? (
				<ListRow
					title={t`Show templates for every stage`}
					leading={showAll ? "check-circle" : "circle"}
					selected={showAll}
					onPress={() => setShowAll(!showAll)}
				/>
			) : null}

			{render.isError ? (
				<Banner
					tone="danger"
					message={t`This template couldn't be filled in. Try again.`}
					action={{ label: t`Try again`, onPress: () => void render.refetch() }}
				/>
			) : !ready ? (
				<Skeleton height={space.s12 * 4} />
			) : (
				<>
					<Text variant="callout" color="ink2">
						{to ? t`To: ${to}` : t`No email address for this contact yet. Add it in your mail app.`}
					</Text>
					<TextField
						label={t`Subject`}
						value={subject}
						maxLength={MAX_SUBJECT_LENGTH}
						onChangeText={(value) => edit({ subject: value })}
					/>
					<TextArea
						label={t`Message`}
						value={body}
						maxLength={MAX_BODY_LENGTH}
						minLines={10}
						onChangeText={(value) => edit({ body: value })}
					/>
					{unfilled ? <Banner tone="warn" message={t`Fill in the [bracketed] parts before you send it.`} /> : null}
					<Button fullWidth icon="envelope-simple" label={t`Open in mail app`} onPress={() => void openMail()} />
					<Button fullWidth variant="secondary" icon="copy" label={t`Copy`} onPress={() => void copy()} />
					<Button fullWidth variant="ghost" label={t`Save as my template`} onPress={() => setSaving(true)} />
					<Text variant="caption" color="ink3">
						{t`You send it from your own email. Nothing is sent from here.`}
					</Text>
				</>
			)}
		</View>
	);
}
