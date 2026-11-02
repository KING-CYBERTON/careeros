// CAREEROS (P2-T07): small pure rules of the branding screens, tested without React Native.

/** Picker types the logo and favicon endpoints accept from a phone (it can't draw or pick SVG or ICO here). */
export const LOGO_TYPES = ["image/png", "image/webp"] as const;
export const FAVICON_TYPES = ["image/png"] as const;
export const LOGO_MAX_BYTES = 512 * 1024;
export const FAVICON_MAX_BYTES = 128 * 1024;

export type AssetKind = "logo" | "favicon";
export type AssetCheck = "ok" | "type" | "size";

/** Checks a picked image before it is sent. The server checks the bytes again. */
export function checkAsset(kind: AssetKind, mimeType: string | null | undefined, size: number): AssetCheck {
	const allowed: readonly string[] = kind === "logo" ? LOGO_TYPES : FAVICON_TYPES;
	if (!mimeType || !allowed.includes(mimeType.toLowerCase())) return "type";
	return size > (kind === "logo" ? LOGO_MAX_BYTES : FAVICON_MAX_BYTES) ? "size" : "ok";
}

/** The file name the upload carries; its extension follows the type, whatever the picker called it. */
export function assetFileName(kind: AssetKind, mimeType: string): string {
	return `${kind}.${mimeType.toLowerCase() === "image/webp" ? "webp" : "png"}`;
}

export type DomainStatus = "pending" | "verified" | "active" | "failed" | "removing";

export const needsRecords = (status: DomainStatus): boolean => status === "pending" || status === "verified";
export const canRecheck = (status: DomainStatus): boolean => status !== "failed" && status !== "removing";

/** The code of an oRPC error, if it has one. */
export const errorCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
