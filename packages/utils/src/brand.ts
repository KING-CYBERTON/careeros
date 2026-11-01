/**
 * CAREEROS: the one source for the product name. Every user-facing surface takes its name from here (web through
 * `getBrand()`/`useBrand()`, server, email and PDF code through a parameter that defaults to this). The server shell
 * fills `BrandInfo` from the organization's branding and injects it as `window.__BRAND__` (P2-T02).
 */
export const PLATFORM_DEFAULT_APP_NAME = "CareerOS";

export type BrandInfo = {
	appName: string;
	logoUrl?: string;
	faviconUrl?: string;
	supportUrl?: string;
	termsUrl?: string;
	privacyUrl?: string;
	/** `#rrggbb`, already validated by the branding API (P2-T01). */
	primaryColor?: string;
	secondaryColor?: string;
	/** One of the fixed branding fonts (`BRANDING_FONTS` in `@reactive-resume/db/schema`). */
	font?: string;
};

/** The neutral platform brand, used when no organization branding is available. */
export const DEFAULT_BRAND: BrandInfo = { appName: PLATFORM_DEFAULT_APP_NAME };

/** Resolves an injected brand (the shape T02 puts on `window.__BRAND__`) against the platform default. */
export function resolveBrand(injected?: Partial<BrandInfo> | null): BrandInfo {
	if (!injected || typeof injected.appName !== "string" || injected.appName.trim() === "") return DEFAULT_BRAND;
	return { ...DEFAULT_BRAND, ...injected, appName: injected.appName };
}

/**
 * The brand in the browser: `window.__BRAND__` when present (injected by the server shell), the platform default
 * otherwise, and always the default outside a browser (prerender, tests, server).
 */
export function getBrand(): BrandInfo {
	const injected = (globalThis as { __BRAND__?: Partial<BrandInfo> }).__BRAND__;
	return resolveBrand(injected);
}

/** The app name as a lowercase slug for file names and identifiers, for example `careeros`. */
export function brandSlug(appName: string = PLATFORM_DEFAULT_APP_NAME): string {
	return (
		appName
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "app"
	);
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** True for `#rrggbb`, the only colour format branding accepts. */
export function isHexColor(value: unknown): value is string {
	return typeof value === "string" && HEX_COLOR.test(value);
}

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
	if (!isHexColor(hex)) throw new RangeError(`Expected a #rrggbb colour, got ${JSON.stringify(hex)}.`);
	return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as Rgb;
}

function toHex([r, g, b]: Rgb): string {
	return `#${[r, g, b]
		.map((value) =>
			Math.round(Math.min(255, Math.max(0, value)))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

/** WCAG 2.x relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
	const [r, g, b] = parseHex(hex).map((channel) => {
		const value = channel / 255;
		return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	}) as Rgb;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(first: string, second: string): number {
	const a = relativeLuminance(first);
	const b = relativeLuminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The text colour to put on `background`: white or black, whichever has the higher WCAG contrast. Always reaches at
 * least 4.5:1 for the larger of the two choices (the worst case, a mid grey, is about 4.6:1).
 */
export function readableForeground(background: string): "#ffffff" | "#000000" {
	return contrastRatio(background, "#ffffff") >= contrastRatio(background, "#000000") ? "#ffffff" : "#000000";
}

/** `weight` (0 to 1) of `other` mixed into `base`, in sRGB. */
export function mixHex(base: string, other: string, weight: number): string {
	const w = Math.min(1, Math.max(0, weight));
	const [a, b] = [parseHex(base), parseHex(other)];
	return toHex(a.map((channel, index) => channel * (1 - w) + (b[index] ?? 0) * w) as Rgb);
}

/**
 * `color` moved toward black (on a light `against`) or white (on a dark one) until it reaches `minimum` contrast with
 * `against`. Returns `color` unchanged when it already does.
 */
export function ensureContrast(color: string, against: string, minimum: number): string {
	const target = relativeLuminance(against) > 0.5 ? "#000000" : "#ffffff";
	let result = color.toLowerCase();
	for (let step = 1; step <= 20 && contrastRatio(result, against) < minimum; step += 1)
		result = mixHex(color, target, step / 20);
	return result;
}

export type AccentTokens = {
	accent: string;
	accentHover: string;
	onAccent: string;
	accentSoft: string;
	accentText: string;
};

const LIGHT_PAPER = "#ffffff";
const DARK_DESK = "#100f0c";

/**
 * The UI's accent tokens (`--accent`, `--accent-hover`, `--on-accent`, `--accent-soft`, `--accent-text` on the web;
 * `accent…` in the mobile theme) for an organization's primary colour, in the light and the dark theme. The primary is
 * kept as is on the light desk; on the dark desk it is lifted until it has 3:1 contrast. Text on the accent uses
 * `readableForeground`, and accent text on the soft tint reaches 4.5:1.
 */
export function accentTokens(primary: string): { light: AccentTokens; dark: AccentTokens } {
	const softLight = mixHex(LIGHT_PAPER, primary, 0.12);
	const accentDark = ensureContrast(primary, DARK_DESK, 3);
	const softDark = mixHex(DARK_DESK, accentDark, 0.22);
	return {
		light: {
			accent: primary.toLowerCase(),
			accentHover: mixHex(primary, "#000000", 0.14),
			onAccent: readableForeground(primary),
			accentSoft: softLight,
			accentText: ensureContrast(primary, softLight, 4.5),
		},
		dark: {
			accent: accentDark,
			accentHover: mixHex(accentDark, "#ffffff", 0.14),
			onAccent: readableForeground(accentDark),
			accentSoft: softDark,
			accentText: ensureContrast(accentDark, softDark, 4.5),
		},
	};
}

// CAREEROS (P2-T04): one mail address with no display name. Mirrors the CHECK on `organization_branding.email_reply_to`:
// exactly one "@", and no whitespace, control character, angle bracket, comma or semicolon, so it cannot carry a second
// address or a header.
// eslint-disable-next-line no-control-regex -- header injection guard.
const SINGLE_EMAIL = /^[^@\s\u0000-\u001f\u007f<>,;]+@[^@\s\u0000-\u001f\u007f<>,;]+$/;

/** True for a single bare mail address, at most 254 characters. */
export function isSingleEmailAddress(value: unknown): value is string {
	return typeof value === "string" && value.length <= 254 && SINGLE_EMAIL.test(value);
}
