import { createHash } from "node:crypto";
import { getPublicBrandingAsset } from "@reactive-resume/api/features/branding";
import { getStorageService } from "@reactive-resume/api/features/storage";
import { matchesIfNoneMatch } from "@reactive-resume/utils/http";

// CAREEROS (P2-T01): serves an organization's logo and favicon. Only the file the branding row currently points at is
// public; any other name under the organization's prefix answers 404. SVG is allowed here (it was sanitized on upload)
// but is locked down with a CSP so it can only be drawn, never run.
const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILENAME = /^(?:logo|favicon)-[0-9a-f-]{36}\.(?:png|webp|svg|ico)$/;
const CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	webp: "image/webp",
	svg: "image/svg+xml",
	ico: "image/x-icon",
};
// Short, so a replaced logo leaves shared caches within the hour.
const CACHE_CONTROL = "public, max-age=3600";

const notFound = () => new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function handleBrandingAssetRequest(request: Request, organizationId: string, filename: string) {
	if (!ORG_ID.test(organizationId) || !FILENAME.test(filename)) return notFound();
	const key = await getPublicBrandingAsset(organizationId, filename);
	if (!key) return notFound();
	const file = await getStorageService().read(key);
	if (!file) return notFound();
	const etag = `"${file.size}-${createHash("sha256").update(file.data).digest("hex")}"`;
	const headers = new Headers({
		"Content-Type": CONTENT_TYPES[filename.split(".").pop() ?? ""] ?? "application/octet-stream",
		"Cache-Control": CACHE_CONTROL,
		ETag: etag,
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
		// Custom domains and the login page load these from the app origin.
		"Cross-Origin-Resource-Policy": "cross-origin",
	});
	if (matchesIfNoneMatch(request.headers.get("If-None-Match"), etag))
		return new Response(null, { status: 304, headers });
	headers.set("Content-Length", file.size.toString());
	return new Response(file.data as Uint8Array<ArrayBuffer>, { headers });
}
