// CAREEROS (P2-T02, D10): the organization brand on the phone. `brandFromPublic` turns the public branding the API
// returns (`branding.publicBySlug`) into a `BrandInfo`; anything that is not in the expected shape is dropped, so a
// bad value can never reach the theme or an `Image` source. Pure: tested without React Native (scripts/branding.test.mjs).
import type { BrandInfo } from "@reactive-resume/utils/brand";
import { DEFAULT_BRAND, isHexColor } from "@reactive-resume/utils/brand";

export type PublicBrandingData = {
	appName?: string | null | undefined;
	logoUrl?: string | null | undefined;
	faviconUrl?: string | null | undefined;
	primaryColor?: string | null | undefined;
	secondaryColor?: string | null | undefined;
	font?: string | null | undefined;
	supportUrl?: string | null | undefined;
	termsUrl?: string | null | undefined;
	privacyUrl?: string | null | undefined;
};

const MAX_APP_NAME = 60;
const ASSET_PATH =
	/^\/api\/branding-assets\/[A-Za-z0-9_-]{1,64}\/(?:logo|favicon)-[0-9a-f-]{36}\.(?:png|webp|svg|ico)$/;

function httpsLink(value: string | null | undefined): string | undefined {
	if (!value?.startsWith("https://") || value.length > 2048) return undefined;
	try {
		const url = new URL(value);
		return url.username === "" && url.password === "" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** A branding image on the server the app signed in to. React Native cannot draw SVG in `Image`, so only bitmaps pass. */
function imageUrl(value: string | null | undefined, server: string): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value, server);
		if (!ASSET_PATH.test(url.pathname) || /\.(?:svg|ico)$/.test(url.pathname)) return undefined;
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

export function brandFromPublic(data: PublicBrandingData, server: string): BrandInfo {
	const appName = data.appName?.trim().slice(0, MAX_APP_NAME) || DEFAULT_BRAND.appName;
	const logoUrl = imageUrl(data.logoUrl, server);
	const supportUrl = httpsLink(data.supportUrl);
	const termsUrl = httpsLink(data.termsUrl);
	const privacyUrl = httpsLink(data.privacyUrl);
	return {
		appName,
		...(logoUrl && { logoUrl }),
		...(supportUrl && { supportUrl }),
		...(termsUrl && { termsUrl }),
		...(privacyUrl && { privacyUrl }),
		...(isHexColor(data.primaryColor) && { primaryColor: data.primaryColor.toLowerCase() }),
	};
}
