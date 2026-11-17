import type { RouterOutput } from "@/api/client";
import type { FormErrors, SearchDraft } from "@careeros/discovery-form";
import {
	BOARD_SOURCE_LABELS,
	BOARD_SOURCES,
	draftFromSource,
	emptyDraft,
	looksLikeUrl,
	MAX_BOARDS_PER_SOURCE,
	parseBoardUrl,
	readServerFormError,
	REMOTE_PREFERENCES,
	SCHEDULES,
	validateDraft,
} from "@careeros/discovery-form";
import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { formErrorText, remoteLabels, scheduleLabels } from "./messages";
import { TermField } from "./term-field";
import { client, orpc } from "@/api/client";
import { entitlementErrorMessage } from "@/features/organization/entitlement-message";
import { Banner, Button, Card, SelectSheet, showToast, Text, TextField, useTheme } from "@/ui";

// CAREEROS (P4-T03): the form that creates and edits a job search, the twin of
// apps/web/src/features/discovery/search-form.tsx. It validates with the same schema as the server
// (`@careeros/discovery-form`) and saves through `discovery.sources.create` and `.update`.
export type SearchSource = RouterOutput["discovery"]["sources"]["list"][number];

export type SearchFormProps = {
	/** The search being edited. Omit to create one. */
	source?: SearchSource | undefined;
	/** Show the AI matching field: the organization has the `platform_ai` feature. */
	showAi: boolean;
	onClose: () => void;
};

const noErrors = (): FormErrors => ({ fields: {}, boardRows: {} });

export function SearchForm({ source, showAi, onClose }: SearchFormProps) {
	const { t } = useLingui();
	const { space } = useTheme();
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<SearchDraft>(() => (source ? draftFromSource(source) : emptyDraft()));
	const [aiText, setAiText] = useState(() => String(source?.aiTopN ?? emptyDraft().aiTopN));
	const [submitted, setSubmitted] = useState(false);
	const [saving, setSaving] = useState(false);
	const [serverErrors, setServerErrors] = useState<FormErrors>(noErrors);
	const [formMessage, setFormMessage] = useState<string>();

	const change = (patch: Partial<SearchDraft>) => {
		setDraft((current) => ({ ...current, ...patch }));
		setServerErrors(noErrors());
		setFormMessage(undefined);
	};

	const local = validateDraft(draft);
	const errors: FormErrors = {
		fields: { ...serverErrors.fields, ...(local.ok ? {} : local.errors.fields) },
		boardRows: { ...serverErrors.boardRows, ...(local.ok ? {} : local.errors.boardRows) },
	};
	const fieldError = (field: keyof FormErrors["fields"]) => {
		const code = errors.fields[field];
		return code ? formErrorText(code) : undefined;
	};
	// A name that is still empty is only reported after the first save attempt.
	const nameCode = errors.fields.name;
	const nameError = nameCode && (submitted || draft.name.length > 0) ? formErrorText(nameCode) : undefined;
	const boardError = (index: number, token: string) => {
		const parsed = looksLikeUrl(token) ? parseBoardUrl(token) : undefined;
		if (parsed?.kind === "unsupported") return t`This board isn't supported yet`;
		if (parsed?.kind === "no_token") return t`Couldn't find the board name in this link.`;
		const code = errors.boardRows[index];
		return code && (submitted || token !== "" || serverErrors.boardRows[index]) ? formErrorText(code) : undefined;
	};

	const setBoard = (index: number, patch: Partial<SearchDraft["boards"][number]>) =>
		change({ boards: draft.boards.map((row, at) => (at === index ? { ...row, ...patch } : row)) });
	const onTokenChange = (index: number, value: string) => {
		const parsed = looksLikeUrl(value) ? parseBoardUrl(value) : undefined;
		if (parsed?.kind === "board") setBoard(index, parsed.board);
		else setBoard(index, { token: value });
	};

	const submit = async () => {
		setSubmitted(true);
		setFormMessage(undefined);
		const result = validateDraft(draft);
		if (!result.ok || saving) return;
		setSaving(true);
		try {
			if (source) await client.discovery.sources.update({ id: source.id, ...result.value });
			else await client.discovery.sources.create(result.value);
			void queryClient.invalidateQueries({ queryKey: orpc.discovery.sources.key() });
			showToast({ message: source ? t`Search saved` : t`Search created` });
			onClose();
		} catch (error) {
			const read = readServerFormError(error);
			setServerErrors(read.errors);
			const tied = Object.keys(read.errors.fields).length > 0 || Object.keys(read.errors.boardRows).length > 0;
			if (read.limitReached !== undefined) {
				const limit = read.limitReached;
				setFormMessage(t`You can have at most ${limit} searches. Delete one to add another.`);
			} else if (!tied) {
				setFormMessage(
					entitlementErrorMessage(error) ?? t`Couldn't save this search. Check your connection and try again.`,
				);
			}
		} finally {
			setSaving(false);
		}
	};

	const remote = remoteLabels();
	const schedule = scheduleLabels();

	return (
		<Card style={{ gap: space.s4 }}>
			<Text variant="title" accessibilityRole="header">
				{source ? t`Edit search` : t`New search`}
			</Text>
			<TextField
				label={t`Name`}
				value={draft.name}
				error={nameError}
				editable={!saving}
				onChangeText={(name) => change({ name })}
			/>
			<TermField
				label={t`Job titles`}
				helper={t`Add one at a time or separate them with commas.`}
				values={draft.titles}
				error={fieldError("titles")}
				onChange={(titles) => change({ titles })}
			/>
			<TermField
				label={t`Skills`}
				values={draft.skills}
				error={fieldError("skills")}
				onChange={(skills) => change({ skills })}
			/>
			<TermField
				label={t`Keywords`}
				values={draft.keywords}
				error={fieldError("keywords")}
				onChange={(keywords) => change({ keywords })}
			/>
			<TermField
				label={t`Locations`}
				values={draft.locations}
				error={fieldError("locations")}
				onChange={(locations) => change({ locations })}
			/>
			<SelectSheet
				label={t`Remote preference`}
				value={draft.remote}
				options={REMOTE_PREFERENCES.map((value) => ({ value, label: remote[value] }))}
				onChange={(value) => change({ remote: value })}
			/>
			<SelectSheet
				label={t`Schedule`}
				value={draft.schedule}
				options={SCHEDULES.map((value) => ({ value, label: schedule[value] }))}
				onChange={(value) => change({ schedule: value })}
			/>

			<View style={{ gap: space.s3 }}>
				<Text variant="callout" weight={600} color="ink2">
					{t`Job boards`}
				</Text>
				<Text variant="callout" color="ink3">
					{t`Pick the board and enter the company's board name, or paste the link to its job page. The name is the part after the host, for example jobs.lever.co/acme or boards.greenhouse.io/acme (acme).`}
				</Text>
				{draft.boards.map((row, index) => (
					<View key={index} style={{ gap: space.s2 }}>
						<SelectSheet
							label={t`Board ${index + 1} source`}
							value={row.source}
							options={BOARD_SOURCES.map((value) => ({ value, label: BOARD_SOURCE_LABELS[value] }))}
							onChange={(value) => setBoard(index, { source: value })}
						/>
						<TextField
							label={t`Board ${index + 1} name or link`}
							value={row.token}
							error={boardError(index, row.token)}
							autoCapitalize="none"
							autoCorrect={false}
							editable={!saving}
							onChangeText={(value) => onTokenChange(index, value)}
						/>
						<Button
							variant="ghost"
							size="sm"
							label={t`Remove board ${index + 1}`}
							onPress={() => change({ boards: draft.boards.filter((_, at) => at !== index) })}
						/>
					</View>
				))}
				{fieldError("boards") ? <Text color="danger">{fieldError("boards")}</Text> : null}
				<Button
					variant="secondary"
					size="sm"
					label={t`Add a board`}
					disabled={draft.boards.length >= MAX_BOARDS_PER_SOURCE}
					onPress={() => change({ boards: [...draft.boards, { source: "greenhouse", token: "" }] })}
				/>
			</View>

			{showAi ? (
				<TextField
					label={t`Jobs to score with AI per run`}
					value={aiText}
					keyboardType="number-pad"
					error={fieldError("aiTopN")}
					helper={t`The best matches of each run get an AI score and a short reason. Each scored job uses AI credits. Your plan may allow fewer. Enter 0 to skip AI.`}
					editable={!saving}
					onChangeText={(text) => {
						setAiText(text);
						change({ aiTopN: text.trim() === "" ? Number.NaN : Number(text) });
					}}
				/>
			) : null}

			{formMessage ? <Banner tone="danger" message={formMessage} /> : null}

			<View style={{ gap: space.s2 }}>
				<Button
					label={source ? t`Save changes` : t`Create search`}
					loading={saving}
					onPress={() => {
						void submit();
					}}
				/>
				<Button variant="ghost" label={t`Cancel`} disabled={saving} onPress={onClose} />
			</View>
		</Card>
	);
}
