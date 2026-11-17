// CAREEROS (P2-T07): the branding form as plain data, shared by the web and mobile settings screens and tested without React. The server checks every
// rule again; these only give the person an answer before they save.
import {
	BRANDING_FONT_NAMES,
	contrastRatio,
	isHexColor,
	isHttpsUrl,
	isSingleEmailAddress,
} from "@reactive-resume/utils/brand";

export const APP_NAME_MAX = 60;
export const SENDER_NAME_MAX = 80;

export type BrandingFont = (typeof BRANDING_FONT_NAMES)[number];

/** Every field is text; an empty string means "use the platform default". */
export type BrandingForm = {
	appName: string;
	primaryColor: string;
	secondaryColor: string;
	font: string;
	emailFromName: string;
	emailReplyTo: string;
	supportUrl: string;
	termsUrl: string;
	privacyUrl: string;
};

export type BrandingData = {
	[K in keyof BrandingForm]: string | null;
};

export type FormError = "name-too-long" | "color" | "font" | "sender" | "sender-too-long" | "email" | "url";
export type FormErrors = Partial<Record<keyof BrandingForm, FormError>>;

export const FIELDS = [
	"appName",
	"primaryColor",
	"secondaryColor",
	"font",
	"emailFromName",
	"emailReplyTo",
	"supportUrl",
	"termsUrl",
	"privacyUrl",
] as const satisfies readonly (keyof BrandingForm)[];

export function formFromBranding(data: BrandingData): BrandingForm {
	return {
		appName: data.appName ?? "",
		primaryColor: data.primaryColor ?? "",
		secondaryColor: data.secondaryColor ?? "",
		font: data.font ?? "",
		emailFromName: data.emailFromName ?? "",
		emailReplyTo: data.emailReplyTo ?? "",
		supportUrl: data.supportUrl ?? "",
		termsUrl: data.termsUrl ?? "",
		privacyUrl: data.privacyUrl ?? "",
	};
}

// eslint-disable-next-line no-control-regex -- the sender name goes into a From header.
const CONTROL_OR_ANGLE = /[\u0000-\u001f\u007f<>]/;

/** The first problem of each field, or none. Empty fields are fine: they reset to the default. */
export function validateForm(form: BrandingForm): FormErrors {
	const errors: FormErrors = {};
	if (form.appName.trim().length > APP_NAME_MAX) errors.appName = "name-too-long";
	for (const field of ["primaryColor", "secondaryColor"] as const) {
		const value = form[field].trim();
		if (value !== "" && !isHexColor(value)) errors[field] = "color";
	}
	const font = form.font.trim();
	if (font !== "" && !(BRANDING_FONT_NAMES as readonly string[]).includes(font)) errors.font = "font";
	const sender = form.emailFromName.trim();
	if (sender.length > SENDER_NAME_MAX) errors.emailFromName = "sender-too-long";
	else if (CONTROL_OR_ANGLE.test(sender)) errors.emailFromName = "sender";
	const replyTo = form.emailReplyTo.trim();
	if (replyTo !== "" && !isSingleEmailAddress(replyTo)) errors.emailReplyTo = "email";
	for (const field of ["supportUrl", "termsUrl", "privacyUrl"] as const) {
		const value = form[field].trim();
		if (value !== "" && !isHttpsUrl(value)) errors[field] = "url";
	}
	return errors;
}

export type BrandingPatch = { [K in keyof BrandingForm]?: (K extends "font" ? BrandingFont : string) | null };

const normalize = (field: keyof BrandingForm, value: string): string | null => {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	return field === "primaryColor" || field === "secondaryColor" ? trimmed.toLowerCase() : trimmed;
};

/** Only the fields that differ from what is stored; an emptied field becomes `null` (reset to the default). */
export function buildPatch(form: BrandingForm, stored: BrandingData): BrandingPatch {
	const patch: BrandingPatch = {};
	for (const field of FIELDS) {
		const next = normalize(field, form[field]);
		// The API checks the font against the list again; the form only offers listed ones.
		if (next !== stored[field]) (patch as Record<string, string | null>)[field] = next;
	}
	return patch;
}

/** Whether `value` is a colour the native colour input can show. */
export const colorInputValue = (value: string, fallback: string): string =>
	isHexColor(value.trim()) ? value.trim().toLowerCase() : fallback;

/** Seconds left until a manual domain recheck is allowed again (one a minute per domain), or 0. */
export function recheckWaitSeconds(lastCheckedAt: Date | string | null, now: number = Date.now()): number {
	if (!lastCheckedAt) return 0;
	const elapsed = now - new Date(lastCheckedAt).getTime();
	return Math.max(0, Math.ceil((60_000 - elapsed) / 1000));
}

/** WCAG AA for large text and UI components. */
export const WHITE_BACKGROUND_MIN_CONTRAST = 3;

/**
 * Whether the primary colour is hard to see on a white background (contrast below 3:1). Only a valid `#rrggbb` colour
 * is judged; anything else returns `null` (the form shows its own error). Web and mobile show the same warning.
 */
export function primaryOnWhite(primary: string): { ratio: number; hard: boolean } | null {
	const value = primary.trim();
	if (!isHexColor(value)) return null;
	const ratio = contrastRatio(value, "#ffffff");
	return { ratio, hard: ratio < WHITE_BACKGROUND_MIN_CONTRAST };
}
