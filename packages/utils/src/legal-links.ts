// CAREEROS (P6-T01, G10): which legal page a footer, sign-up form or settings screen links to. An organization's own
// `termsUrl` / `privacyUrl` (P2-T01) win; without one, the platform's pages at `/terms` and `/privacy` are the default,
// so every host has a working link. Shared by the web app and the mobile app.
import type { BrandInfo } from "./brand";

/** The platform's own legal pages. `/dpa` is for organization customers, so no brand setting overrides it. */
export const LEGAL_PAGE_PATHS = { terms: "/terms", privacy: "/privacy", dpa: "/dpa" } as const;

export type LegalLink = {
	href: string;
	/** True for an absolute address (an organization's own page, or a platform page on a given origin). */
	external: boolean;
	/** True when the link is the platform's page, false when it is the organization's own. */
	platform: boolean;
};

export type LegalLinks = { terms: LegalLink; privacy: LegalLink };

const trimmedOrUndefined = (value: string | null | undefined) => {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
};

function link(own: string | undefined, path: string, origin: string): LegalLink {
	if (own) return { href: own, external: true, platform: false };
	const href = `${origin.replace(/\/+$/, "")}${path}`;
	return { href, external: !href.startsWith("/"), platform: true };
}

/**
 * The terms and privacy links for a brand. `origin` is empty in the web app (the page is on the same host, so the link
 * is a path) and the server address in the mobile app (which opens it in the in-app browser).
 */
export function resolveLegalLinks(
	brand: Pick<BrandInfo, "termsUrl" | "privacyUrl"> | null | undefined,
	origin = "",
): LegalLinks {
	return {
		terms: link(trimmedOrUndefined(brand?.termsUrl), LEGAL_PAGE_PATHS.terms, origin),
		privacy: link(trimmedOrUndefined(brand?.privacyUrl), LEGAL_PAGE_PATHS.privacy, origin),
	};
}
