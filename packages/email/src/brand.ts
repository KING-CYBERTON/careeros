import {
	isHexColor,
	isSingleEmailAddress,
	PLATFORM_DEFAULT_APP_NAME,
	readableForeground,
} from "@reactive-resume/utils/brand";

// CAREEROS (P2-T04): the brand an email is sent in. Every field is optional except the name; with no brand at all an
// email is the neutral platform one. The values come from `organization_branding` (validated on write), but the
// templates check them again because a template must never put an unchecked value into a style or a link.

export type EmailBrand = {
	appName: string;
	/** Absolute URL of a PNG or JPEG logo. An SVG or WebP logo is left out: many mail clients block them. */
	logoUrl?: string | undefined;
	/** `#rrggbb`. */
	primaryColor?: string | undefined;
	/** `#ffffff` or `#000000`, the readable text colour on `primaryColor`. */
	primaryForeground?: string | undefined;
	supportUrl?: string | undefined;
	privacyUrl?: string | undefined;
	termsUrl?: string | undefined;
};

export const DEFAULT_EMAIL_BRAND: EmailBrand = { appName: PLATFORM_DEFAULT_APP_NAME };

// eslint-disable-next-line no-control-regex -- header injection guard.
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A product name that is safe in a subject line and a body: no control characters (so no line breaks), trimmed. */
export function cleanAppName(value: string | null | undefined): string {
	const name = (value ?? "").replaceAll(CONTROL, " ").replaceAll(/\s+/g, " ").trim().slice(0, 80);
	return name || PLATFORM_DEFAULT_APP_NAME;
}

const isHttpUrl = (value: string | undefined, schemes: readonly string[]): value is string => {
	if (!value) return false;
	try {
		const url = new URL(value);
		return schemes.includes(url.protocol) && url.username === "" && url.password === "" && url.hostname !== "";
	} catch {
		return false;
	}
};

export type ResolvedEmailBrand = {
	appName: string;
	logoUrl: string | undefined;
	primaryColor: string | undefined;
	primaryForeground: string | undefined;
	links: { label: string; url: string }[];
};

/** The brand with every value checked: a bad colour or URL is dropped, never rendered. */
export function resolveEmailBrand(brand: EmailBrand | undefined): ResolvedEmailBrand {
	const appName = cleanAppName(brand?.appName);
	const primaryColor = isHexColor(brand?.primaryColor) ? brand.primaryColor : undefined;
	const links = [
		{ label: "Support", url: brand?.supportUrl },
		{ label: "Privacy", url: brand?.privacyUrl },
		{ label: "Terms", url: brand?.termsUrl },
	].flatMap(({ label, url }) => (isHttpUrl(url, ["https:"]) ? [{ label, url }] : []));
	return {
		appName,
		logoUrl:
			isHttpUrl(brand?.logoUrl, ["https:", "http:"]) && /\.(?:png|jpe?g)$/i.test(new URL(brand.logoUrl).pathname)
				? brand.logoUrl
				: undefined,
		primaryColor,
		primaryForeground: primaryColor
			? isHexColor(brand?.primaryForeground)
				? brand.primaryForeground
				: readableForeground(primaryColor)
			: undefined,
		links,
	};
}

// eslint-disable-next-line no-control-regex -- header injection guard: the name goes into a From header.
const UNSAFE_NAME_CHARACTERS = /["\\<>\u0000-\u001f\u007f]/g;
const MAX_DISPLAY_NAME_LENGTH = 64;

/** A display name that cannot break out of its quoted header value: no quote, backslash, angle bracket or control character. */
export const cleanDisplayName = (name: string | null | undefined): string =>
	(name ?? "")
		.replaceAll(UNSAFE_NAME_CHARACTERS, "")
		.replaceAll(/\s+/g, " ")
		.trim()
		.slice(0, MAX_DISPLAY_NAME_LENGTH)
		.trim();

/** The Reply-To header value: a single bare address, else none. */
export const safeReplyTo = (replyTo: string | null | undefined): string | undefined =>
	isSingleEmailAddress(replyTo) ? replyTo : undefined;
