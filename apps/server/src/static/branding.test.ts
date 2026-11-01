import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixtures = vi.hoisted(() => ({
	asset: vi.fn<(organizationId: string, filename: string) => Promise<string | null>>(),
	read: vi.fn<(key: string) => Promise<{ data: Uint8Array; size: number } | null>>(),
}));
vi.mock("@reactive-resume/api/features/branding", () => ({ getPublicBrandingAsset: fixtures.asset }));
vi.mock("@reactive-resume/api/features/storage", () => ({ getStorageService: () => ({ read: fixtures.read }) }));

import { handleBrandingAssetRequest } from "./branding";

const FILE = "logo-123e4567-e89b-12d3-a456-426614174000.svg";
const request = (headers: Record<string, string> = {}) => new Request("https://app.example/x", { headers });

describe("handleBrandingAssetRequest", () => {
	beforeEach(() => {
		fixtures.asset.mockReset();
		fixtures.read.mockReset();
	});

	it("serves the current file with a locked-down SVG policy", async () => {
		fixtures.asset.mockResolvedValue(`orgs/org-a/branding/${FILE}`);
		fixtures.read.mockResolvedValue({ data: new TextEncoder().encode("<svg></svg>"), size: 11 });
		const response = await handleBrandingAssetRequest(request(), "org-a", FILE);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
		expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(fixtures.asset).toHaveBeenCalledWith("org-a", FILE);
		expect(fixtures.read).toHaveBeenCalledWith(`orgs/org-a/branding/${FILE}`);
		const etag = response.headers.get("ETag") ?? "";
		expect((await handleBrandingAssetRequest(request({ "If-None-Match": etag }), "org-a", FILE)).status).toBe(304);
	});

	it("answers 404 for a file the branding no longer points at, missing storage and malformed names", async () => {
		fixtures.asset.mockResolvedValue(null);
		expect((await handleBrandingAssetRequest(request(), "org-a", FILE)).status).toBe(404);
		fixtures.asset.mockResolvedValue(`orgs/org-a/branding/${FILE}`);
		fixtures.read.mockResolvedValue(null);
		expect((await handleBrandingAssetRequest(request(), "org-a", FILE)).status).toBe(404);
		fixtures.asset.mockClear();
		for (const [org, name] of [
			["org-a", "../secret.png"],
			["org-a", "logo.png"],
			["org a", FILE],
			["../org-b", FILE],
		] as const)
			expect((await handleBrandingAssetRequest(request(), org, name)).status).toBe(404);
		expect(fixtures.asset).not.toHaveBeenCalled();
	});
});
