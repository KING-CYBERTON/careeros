import { addTerms, MAX_TERM_LENGTH, removeTerm } from "@careeros/discovery-form";
import { t } from "@lingui/core/macro";
import { useId, useState } from "react";
import { Input } from "@reactive-resume/ui/components/input";
import { formErrorText } from "./search-messages";
import { isImeComposing } from "@/libs/keyboard";

// CAREEROS (P4-T03): a list of short entries as chips. Enter or a comma adds what was typed; a paste with commas adds each.
type ChipInputProps = {
	label: string;
	hint?: string;
	values: string[];
	onChange: (values: string[]) => void;
	/** A validation message from the form (for example, too many entries). */
	error?: string | undefined;
};

export function ChipInput({ label, hint, values, onChange, error }: ChipInputProps) {
	const id = useId();
	const [text, setText] = useState("");
	const [localError, setLocalError] = useState<string>();

	const commit = (raw: string) => {
		const result = addTerms(values, raw);
		onChange(result.terms);
		setLocalError(result.error ? formErrorText(result.error) : undefined);
		// An entry that was refused stays in the field so the member can shorten it.
		setText(result.error === "term_too_long" ? raw : "");
	};
	const message = localError ?? error;

	return (
		<div className="grid gap-1.5">
			<label htmlFor={id} className="text-xs font-medium text-ink-2">
				{label}
			</label>
			{values.length > 0 && (
				<ul className="flex flex-wrap gap-1.5" aria-label={label}>
					{values.map((value) => (
						<li
							key={value}
							className="inline-flex max-w-full items-center gap-1 rounded-sm bg-sunken py-0.5 ps-2 pe-1 text-xs text-ink-2"
						>
							<span className="break-all">{value}</span>
							<button
								type="button"
								aria-label={t`Remove ${value}`}
								className="rounded-sm px-1 text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
								onClick={() => onChange(removeTerm(values, value))}
							>
								<span aria-hidden="true">×</span>
							</button>
						</li>
					))}
				</ul>
			)}
			<Input
				id={id}
				value={text}
				maxLength={MAX_TERM_LENGTH * 5}
				aria-invalid={!!message}
				aria-describedby={message ? `${id}-error` : hint ? `${id}-hint` : undefined}
				onChange={(event) => {
					const next = event.target.value;
					if (next.includes(",") || next.includes("\n")) commit(next);
					else {
						setText(next);
						setLocalError(undefined);
					}
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !isImeComposing(event)) {
						event.preventDefault();
						if (text.trim()) commit(text);
					} else if (event.key === "Backspace" && text === "" && values.length > 0) {
						onChange(values.slice(0, -1));
					}
				}}
				onBlur={() => {
					if (text.trim()) commit(text);
				}}
			/>
			{message ? (
				<p id={`${id}-error`} role="alert" className="text-xs text-danger-text">
					{message}
				</p>
			) : hint ? (
				<p id={`${id}-hint`} className="text-xs text-ink-3">
					{hint}
				</p>
			) : null}
		</div>
	);
}
