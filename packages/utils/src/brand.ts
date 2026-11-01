/**
 * CAREEROS: the one source for the product name. Every user-facing surface takes its name from here (web through
 * `getBrand()`/`useBrand()`, server, email and PDF code through a parameter that defaults to this). P2-T02 later fills
 * `BrandInfo` from the organization's branding.
 */
export const PLATFORM_DEFAULT_APP_NAME = "CareerOS";

export type BrandInfo = {
	appName: string;
	logoUrl?: string;
	faviconUrl?: string;
	supportUrl?: string;
	termsUrl?: string;
	privacyUrl?: string;
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
