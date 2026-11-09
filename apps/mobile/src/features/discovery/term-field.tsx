import { addTerms, removeTerm } from "@careeros/discovery-form";
import { useState } from "react";
import { View } from "react-native";
import { formErrorText } from "./messages";
import { Chip, TextField, useTheme } from "@/ui";

// CAREEROS (P4-T03): a list of short entries as chips for the search form. The mobile ChipInput in `@/ui` only skips
// exact duplicates; this one applies the server's limits (50 entries of 100 characters, case-insensitive duplicates).
export type TermFieldProps = {
	label: string;
	values: string[];
	onChange: (values: string[]) => void;
	helper?: string | undefined;
	error?: string | undefined;
};

export function TermField({ label, values, onChange, helper, error }: TermFieldProps) {
	const { space } = useTheme();
	const [text, setText] = useState("");
	const [localError, setLocalError] = useState<string>();

	const commit = (raw: string) => {
		const result = addTerms(values, raw);
		onChange(result.terms);
		setLocalError(result.error ? formErrorText(result.error) : undefined);
		// An entry that was refused stays in the field so it can be shortened.
		setText(result.error === "term_too_long" ? raw : "");
	};

	return (
		<View style={{ gap: space.s2 }}>
			{values.length > 0 ? (
				<View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s1 + space.s0, paddingVertical: space.s1 }}>
					{values.map((value) => (
						<Chip key={value} label={value} selected onRemove={() => onChange(removeTerm(values, value))} />
					))}
				</View>
			) : null}
			<TextField
				label={label}
				value={text}
				helper={helper}
				error={localError ?? error}
				onChangeText={(next) => {
					if (next.includes(",") || next.includes("\n")) commit(next);
					else {
						setText(next);
						setLocalError(undefined);
					}
				}}
				onSubmitEditing={() => {
					if (text.trim()) commit(text);
				}}
				onBlur={() => {
					if (text.trim()) commit(text);
				}}
				submitBehavior="submit"
				returnKeyType="done"
				autoCapitalize="none"
			/>
		</View>
	);
}
