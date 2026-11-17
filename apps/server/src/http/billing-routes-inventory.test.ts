import { describe, expect, it, vi } from "vite-plus/test";
import { BILLING_PUBLIC_ROUTES } from "@careeros/testing/public-route-inventory";

// CAREEROS (P3-T05): every route the server registers under /api/billing/ is in the public route inventory, with how it
// is protected and where its organization comes from. A new billing route fails here until it is classified.

vi.mock("./auth", () => ({ handleAuth: vi.fn(), handleOAuth: vi.fn() }));
vi.mock("./health", () => ({ handleHealth: vi.fn() }));
vi.mock("../rpc/handler", () => ({ handleRpc: vi.fn() }));
vi.mock("../openapi/handler", () => ({ handleOpenApi: vi.fn(), handleOpenApiDocument: vi.fn() }));
vi.mock("../openapi/metadata", () => ({
	handleMcpServerCard: vi.fn(),
	handleIntegrations: vi.fn(),
	handleApiCatalog: vi.fn(),
	handleOAuthAuthorizationServer: vi.fn(),
	handleOAuthProtectedResource: vi.fn(),
	handleOpenIdConfiguration: vi.fn(),
	handleWellKnownFallback: vi.fn(),
	handleAgentCatalog: vi.fn(),
}));
vi.mock("../static/uploads", () => ({ handleUpload: vi.fn() }));
vi.mock("../static/seo", () => ({ handleRobots: vi.fn(), handleSitemap: vi.fn(), handleLlms: vi.fn() }));
vi.mock("../static/web", () => ({
	serveWebDistStatic: vi.fn(),
	handleWebApp: vi.fn(),
	isPublicResumePath: () => false,
	isProfilePath: () => false,
}));
vi.mock("../mcp/handler", () => ({ handleMcp: vi.fn() }));
vi.mock("./resume-pdf", () => ({ handleResumePdfDownload: vi.fn() }));
vi.mock("./public-resume-pdf", () => ({ handlePublicResumePdf: vi.fn() }));

describe("billing public route inventory", () => {
	it("lists exactly the routes registered under /api/billing/", async () => {
		const { createApp } = await import("./app");
		const app = createApp({ serveStatic: false });
		const registered = new Set(
			app.routes
				.filter((route) => route.path.startsWith("/api/billing/") && route.method !== "ALL")
				.map((route) => `${route.method} ${route.path}`),
		);
		expect([...registered].sort()).toEqual(Object.keys(BILLING_PUBLIC_ROUTES).sort());
	});

	it("classifies the provider webhook as public and signature-verified, on the platform host, organization from signed metadata", () => {
		expect(BILLING_PUBLIC_ROUTES["POST /api/billing/webhook/:provider"]).toMatchObject({
			class: "public-signature-verified",
			host: "platform",
			orgFrom: "signed-metadata",
		});
	});

	it("gives every entry a reason and none of them takes its organization from the host", () => {
		for (const [key, route] of Object.entries(BILLING_PUBLIC_ROUTES)) {
			expect(route.reason.length, key).toBeGreaterThan(40);
			expect(["signed-metadata", "signed-token"], key).toContain(route.orgFrom);
		}
	});
});
