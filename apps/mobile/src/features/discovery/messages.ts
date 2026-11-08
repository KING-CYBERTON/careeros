import type { FormErrorCode } from "@careeros/discovery-form";
import { MAX_AI_TOP_N, MAX_NAME_LENGTH, MAX_TERM_LENGTH, MAX_TERMS } from "@careeros/discovery-form";
import { t } from "@lingui/core/macro";

// CAREEROS (P4-T03): the words for each validation code of `@careeros/discovery-form`, the twin of
// apps/web/src/features/discovery/search-messages.ts. The limits come from the shared package.

export function formErrorText(code: FormErrorCode): string {
	switch (code) {
		case "name_required":
			return t`Give this search a name.`;
		case "name_too_long":
			return t`Use at most ${MAX_NAME_LENGTH} characters.`;
		case "too_many_terms":
			return t`Add at most ${MAX_TERMS} entries.`;
		case "term_too_long":
			return t`Each entry can have at most ${MAX_TERM_LENGTH} characters.`;
		case "too_many_boards":
			return t`Add at most 100 boards.`;
		case "token_required":
			return t`Enter the board name or paste its link.`;
		case "token_invalid":
			return t`A board name has only letters, digits, hyphens and underscores.`;
		case "ai_top_n_invalid":
			return t`Enter a whole number from 0 to ${MAX_AI_TOP_N}.`;
		case "ai_top_n_over_cap":
			return t`Your plan allows fewer jobs per run.`;
		default:
			return t`Check this field.`;
	}
}

export const remoteLabels = () => ({
	any: t`Any`,
	remote: t`Remote`,
	onsite: t`On-site`,
	hybrid: t`Hybrid`,
});

export const scheduleLabels = () => ({
	daily: t`Daily`,
	weekly: t`Weekly`,
	paused: t`Paused`,
});
