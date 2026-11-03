import { plural, t } from "@lingui/core/macro";
import { ORPCError } from "@orpc/client";
import { toast } from "@reactive-resume/ui/components/toast";
// CAREEROS (P3-T02): the plan and status refusals of the server
import { entitlementErrorCode } from "@reactive-resume/utils/entitlement-error";

/** CAREEROS (P3-T02): readable text for SEAT_LIMIT_REACHED, ORG_SUSPENDED and FEATURE_NOT_IN_PLAN (oRPC or Better Auth). */
export function getEntitlementErrorMessage(error: unknown): string | undefined {
	switch (entitlementErrorCode(error)) {
		case "SEAT_LIMIT_REACHED":
			return t`This organization has no free seats. Remove a member or an invitation, or ask the owner to add seats.`;
		case "ORG_SUSPENDED":
			return t`This organization is suspended. You can view and export your data. Contact your administrator.`;
		case "FEATURE_NOT_IN_PLAN":
			return t`This feature is not part of your organization's plan.`;
		default:
			return undefined;
	}
}

export function getReadableErrorMessage(error: unknown, fallback: string): string {
	// CAREEROS (P3-T02)
	const entitlementMessage = getEntitlementErrorMessage(error);
	if (entitlementMessage) return entitlementMessage;
	// A font download failed (see `assertPdfFonts`).
	if (error instanceof Error && error.cause === "pdf-text-loss") return t`Fonts could not be loaded. Try again.`;
	if (error instanceof ORPCError && error.code === "BAD_REQUEST") {
		const data: unknown = error.data;
		if (typeof data === "object" && data !== null && "issues" in data && Array.isArray(data.issues)) {
			const messages = new Set<string>();
			for (const issue of data.issues) {
				if (typeof issue !== "object" || issue === null || typeof issue.message !== "string") continue;
				const message = issue.message.trim();
				if (message) messages.add(message);
				if (messages.size === 3) break;
			}
			if (messages.size > 0) return [...messages].join(" ");
		}
	}

	if (typeof error === "string" && error) return error;
	if (error instanceof Error && error.message) return error.message;
	// Better Auth client errors are plain objects ({ code, message, status }), not Error instances.
	if (typeof error === "object" && error !== null && "message" in error) {
		const { message } = error as { message?: unknown };
		if (typeof message === "string" && message) return message;
	}
	return fallback;
}

type ErrorMessageByCode = Record<string, string>;

export function getOrpcErrorMessage(
	error: unknown,
	options: {
		fallback: string;
		byCode?: ErrorMessageByCode;
		allowServerMessage?: boolean;
	},
): string {
	if (!(error instanceof ORPCError)) return getReadableErrorMessage(error, options.fallback);
	// CAREEROS (P3-T02): a plan or status refusal reads the same wherever it is raised
	const entitlementMessage = getEntitlementErrorMessage(error);
	if (entitlementMessage) return entitlementMessage;
	if (error.code === "AI_CREDENTIAL_DECRYPTION_FAILED")
		return t`The saved provider key can't be decrypted. Enter the key again in Settings → AI & developer.`;
	// CAREEROS (P3-T03): the organization's AI allowance is used up. Shown wherever an AI action fails.
	if (error.code === "AI_QUOTA_EXCEEDED")
		return t`Your organization has used all of this month's AI allowance. Add your own AI provider in Settings → AI & developer to keep going, or ask an admin about the plan.`;

	const mappedMessage = options.byCode?.[error.code];
	if (mappedMessage) return mappedMessage;

	if (options.allowServerMessage && error.message) return error.message;
	return options.fallback;
}

/** An error toast naming what failed; a mapped server message wins over the fallback. */
export function toastError(
	error: unknown,
	fallback: string,
	options: Omit<Parameters<typeof getOrpcErrorMessage>[1], "fallback"> = {},
) {
	toast.add({ type: "error", description: getOrpcErrorMessage(error, { ...options, fallback }) });
}

export function getResumeErrorMessage(error: unknown): string {
	return getOrpcErrorMessage(error, {
		byCode: {
			RESUME_SLUG_ALREADY_EXISTS: t`Another resume already uses this address. Choose a different one.`,
			RESUME_LOCKED: t`This resume is locked. Unlock it to make changes.`,
			INVALID_SLUG: `${t`Use at most 64 characters.`} ${t`The address must contain only lowercase letters and numbers, separated by single dashes.`}`,
		},
		fallback: t`Something went wrong. Please try again.`,
	});
}

/** Characters no font in the resume can draw, as the PDF engine names them (`"₹" (U+20B9)`); they print as "?". */
export function getLostCharactersMessage(characters: readonly string[]): string {
	if (characters.length === 0)
		return t`Your selected font can't display some characters. They show as “?”. In Design, choose a font that has them.`;
	const list = characters.join(", ");
	return plural(characters.length, {
		one: `Your selected font can't display ${list}. It shows as “?”. In Design, choose a font that has it.`,
		other: `Your selected font can't display ${list}. They show as “?”. In Design, choose a font that has them.`,
	});
}
