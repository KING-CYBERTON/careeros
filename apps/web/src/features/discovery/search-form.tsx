import type { RouterOutput } from "@/libs/orpc/client";
import type { FormErrors, SearchDraft } from "@careeros/discovery-form";
import {
	BOARD_SOURCE_LABELS,
	BOARD_SOURCES,
	draftFromSource,
	emptyDraft,
	looksLikeUrl,
	MAX_AI_TOP_N,
	MAX_BOARDS_PER_SOURCE,
	MAX_NAME_LENGTH,
	parseBoardUrl,
	readServerFormError,
	REMOTE_PREFERENCES,
	SCHEDULES,
	validateDraft,
} from "@careeros/discovery-form";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { toast } from "@reactive-resume/ui/components/toast";
import { ChipInput } from "./chip-input";
import { formErrorText, remoteLabels, scheduleLabels } from "./search-messages";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P4-T03): the form that creates and edits a job search. It validates with the same schema as the server
// (`@careeros/discovery-form`) and saves through `discovery.sources.create` and `.update`.
export type SearchSource = RouterOutput["discovery"]["sources"]["list"][number];

type SearchFormProps = {
	/** The search being edited. Omit to create one. */
	source?: SearchSource;
	/** Show the AI matching field: the organization has the `platform_ai` feature. */
	showAi: boolean;
	onClose: () => void;
};

const noErrors = (): FormErrors => ({ fields: {}, boardRows: {} });

export function SearchForm({ source, showAi, onClose }: SearchFormProps) {
	const id = useId();
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<SearchDraft>(() => (source ? draftFromSource(source) : emptyDraft()));
	const [submitted, setSubmitted] = useState(false);
	const [serverErrors, setServerErrors] = useState<FormErrors>(noErrors);
	const [formMessage, setFormMessage] = useState<string>();
	const change = (patch: Partial<SearchDraft>) => {
		setDraft((current) => ({ ...current, ...patch }));
		setServerErrors(noErrors());
		setFormMessage(undefined);
	};

	const onSaved = () => {
		void queryClient.invalidateQueries({ queryKey: orpc.discovery.sources.key() });
		toast.add({ type: "success", description: source ? t`Search saved.` : t`Search created.` });
		onClose();
	};
	const onError = (error: unknown) => {
		const read = readServerFormError(error);
		setServerErrors(read.errors);
		if (read.limitReached !== undefined) {
			const limit = read.limitReached;
			setFormMessage(t`You can have at most ${limit} searches. Delete one to add another.`);
		} else if (
			!read.recognised ||
			(!Object.keys(read.errors.fields).length && !Object.keys(read.errors.boardRows).length)
		) {
			setFormMessage(getOrpcErrorMessage(error, { fallback: t`Couldn't save this search. Try again.` }));
		}
	};
	const create = useMutation(orpc.discovery.sources.create.mutationOptions({ onSuccess: onSaved, onError }));
	const update = useMutation(orpc.discovery.sources.update.mutationOptions({ onSuccess: onSaved, onError }));
	const saving = create.isPending || update.isPending;

	const local = validateDraft(draft);
	const errors: FormErrors = {
		fields: { ...serverErrors.fields, ...(local.ok ? {} : local.errors.fields) },
		boardRows: { ...serverErrors.boardRows, ...(local.ok ? {} : local.errors.boardRows) },
	};
	const showError = (field: keyof FormErrors["fields"]) => {
		const code = errors.fields[field];
		return code ? formErrorText(code) : undefined;
	};
	// A name that is still empty is only reported after the first save attempt.
	const nameError =
		errors.fields.name && (submitted || draft.name.length > 0) ? formErrorText(errors.fields.name) : undefined;

	const submit = () => {
		setSubmitted(true);
		setFormMessage(undefined);
		const result = validateDraft(draft);
		if (!result.ok || saving) return;
		if (source) update.mutate({ id: source.id, ...result.value });
		else create.mutate(result.value);
	};

	const setBoard = (index: number, patch: Partial<SearchDraft["boards"][number]>) =>
		change({ boards: draft.boards.map((row, at) => (at === index ? { ...row, ...patch } : row)) });
	const onTokenChange = (index: number, value: string) => {
		const parsed = looksLikeUrl(value) ? parseBoardUrl(value) : undefined;
		if (parsed?.kind === "board") setBoard(index, parsed.board);
		else setBoard(index, { token: value });
	};
	const boardRowError = (index: number, token: string) => {
		const parsed = looksLikeUrl(token) ? parseBoardUrl(token) : undefined;
		if (parsed?.kind === "unsupported") return t`This board isn't supported yet`;
		if (parsed?.kind === "no_token") return t`Couldn't find the board name in this link.`;
		const code = errors.boardRows[index];
		return code && (submitted || token !== "" || serverErrors.boardRows[index]) ? formErrorText(code) : undefined;
	};

	const remote = remoteLabels();
	const schedule = scheduleLabels();

	return (
		<form
			noValidate
			aria-label={source ? t`Edit search` : t`New search`}
			className="grid gap-4 rounded-xl border border-line bg-surface p-4 text-start"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<h3 className="text-base font-semibold">{source ? <Trans>Edit search</Trans> : <Trans>New search</Trans>}</h3>

			<fieldset disabled={saving} className="grid gap-4">
				<div className="grid gap-1.5">
					<label htmlFor={`${id}-name`} className="text-xs font-medium text-ink-2">
						<Trans>Name</Trans>
					</label>
					<Input
						id={`${id}-name`}
						value={draft.name}
						maxLength={MAX_NAME_LENGTH + 50}
						required
						aria-invalid={!!nameError}
						aria-describedby={nameError ? `${id}-name-error` : undefined}
						onChange={(event) => change({ name: event.target.value })}
					/>
					{nameError && (
						<p id={`${id}-name-error`} role="alert" className="text-xs text-danger-text">
							{nameError}
						</p>
					)}
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<ChipInput
						label={t`Job titles`}
						hint={t`Press Enter or comma to add. For example: Product Manager.`}
						values={draft.titles}
						error={showError("titles")}
						onChange={(titles) => change({ titles })}
					/>
					<ChipInput
						label={t`Skills`}
						values={draft.skills}
						error={showError("skills")}
						onChange={(skills) => change({ skills })}
					/>
					<ChipInput
						label={t`Keywords`}
						values={draft.keywords}
						error={showError("keywords")}
						onChange={(keywords) => change({ keywords })}
					/>
					<ChipInput
						label={t`Locations`}
						values={draft.locations}
						error={showError("locations")}
						onChange={(locations) => change({ locations })}
					/>
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="grid gap-1.5">
						<label htmlFor={`${id}-remote`} className="text-xs font-medium text-ink-2">
							<Trans>Remote preference</Trans>
						</label>
						<NativeSelect
							id={`${id}-remote`}
							value={draft.remote}
							onChange={(event) => change({ remote: event.target.value as SearchDraft["remote"] })}
						>
							{REMOTE_PREFERENCES.map((value) => (
								<option key={value} value={value}>
									{remote[value]}
								</option>
							))}
						</NativeSelect>
					</div>
					<div className="grid gap-1.5">
						<label htmlFor={`${id}-schedule`} className="text-xs font-medium text-ink-2">
							<Trans>Schedule</Trans>
						</label>
						<NativeSelect
							id={`${id}-schedule`}
							value={draft.schedule}
							onChange={(event) => change({ schedule: event.target.value as SearchDraft["schedule"] })}
						>
							{SCHEDULES.map((value) => (
								<option key={value} value={value}>
									{schedule[value]}
								</option>
							))}
						</NativeSelect>
					</div>
				</div>

				<div className="grid gap-2">
					<div className="grid gap-0.5">
						<span className="text-xs font-medium text-ink-2">
							<Trans>Job boards</Trans>
						</span>
						<p className="text-xs text-ink-3">
							<Trans>
								Pick the board and enter the company's board name, or paste the link to its job page. The name is the
								part after the host, for example jobs.lever.co/acme or boards.greenhouse.io/acme (acme).
							</Trans>
						</p>
					</div>
					{draft.boards.map((row, index) => {
						const message = boardRowError(index, row.token);
						return (
							<div key={index} className="grid gap-1">
								<div className="grid grid-cols-[9rem_1fr_auto] items-start gap-2 max-sm:grid-cols-1">
									<NativeSelect
										aria-label={t`Board ${index + 1} source`}
										value={row.source}
										onChange={(event) => setBoard(index, { source: event.target.value as typeof row.source })}
									>
										{BOARD_SOURCES.map((value) => (
											<option key={value} value={value}>
												{BOARD_SOURCE_LABELS[value]}
											</option>
										))}
									</NativeSelect>
									<Input
										aria-label={t`Board ${index + 1} name or link`}
										value={row.token}
										autoCapitalize="none"
										autoCorrect="off"
										spellCheck={false}
										aria-invalid={!!message}
										onChange={(event) => onTokenChange(index, event.target.value)}
									/>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										aria-label={t`Remove board ${index + 1}`}
										onClick={() => change({ boards: draft.boards.filter((_, at) => at !== index) })}
									>
										<Trans>Remove</Trans>
									</Button>
								</div>
								{message && (
									<p role="alert" className="text-xs text-danger-text">
										{message}
									</p>
								)}
							</div>
						);
					})}
					{showError("boards") && (
						<p role="alert" className="text-xs text-danger-text">
							{showError("boards")}
						</p>
					)}
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="justify-self-start"
						disabled={draft.boards.length >= MAX_BOARDS_PER_SOURCE}
						onClick={() => change({ boards: [...draft.boards, { source: "greenhouse", token: "" }] })}
					>
						<Trans>Add a board</Trans>
					</Button>
				</div>

				{showAi && (
					<div className="grid gap-1.5">
						<label htmlFor={`${id}-ai`} className="text-xs font-medium text-ink-2">
							<Trans>Jobs to score with AI per run</Trans>
						</label>
						<Input
							id={`${id}-ai`}
							type="number"
							inputMode="numeric"
							min={0}
							max={MAX_AI_TOP_N}
							step={1}
							value={Number.isNaN(draft.aiTopN) ? "" : draft.aiTopN}
							aria-invalid={!!showError("aiTopN")}
							aria-describedby={`${id}-ai-help`}
							className="max-w-32"
							onChange={(event) =>
								change({ aiTopN: event.target.value === "" ? Number.NaN : Number(event.target.value) })
							}
						/>
						<p id={`${id}-ai-help`} className="text-xs text-ink-3">
							{showError("aiTopN") ?? (
								<Trans>
									The best matches of each run get an AI score and a short reason. Each scored job uses AI credits. Your
									plan may allow fewer. Enter 0 to skip AI.
								</Trans>
							)}
						</p>
					</div>
				)}
			</fieldset>

			{formMessage && (
				<p role="alert" className="text-sm text-danger-text">
					{formMessage}
				</p>
			)}

			<div className="flex flex-wrap items-center gap-2">
				<Button type="submit" loading={saving}>
					{source ? <Trans>Save changes</Trans> : <Trans>Create search</Trans>}
				</Button>
				<Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
					<Trans>Cancel</Trans>
				</Button>
			</div>
		</form>
	);
}
