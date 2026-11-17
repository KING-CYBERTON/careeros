import { describe, expect, it } from "vite-plus/test";
import { Hono } from "hono";
import { EXTENSION_CORS_PATH, extensionBrandingCors } from "./extension-cors";

const app = new Hono();
app.use(EXTENSION_CORS_PATH, extensionBrandingCors);
app.get(EXTENSION_CORS_PATH, (c) => c.json({ appName: null }));
app.get("/api/openapi/branding/public/acme", (c) => c.json({ slug: "acme" }));
app.get("/api/openapi/resumes", (c) => c.json([]));

const get = (path: string, origin?: string) =>
	app.request(path, { headers: origin ? { origin, cookie: "session=1" } : {} });

describe("extensionBrandingCors", () => {
	it.each([
		"chrome-extension://abcdefghijklmnopabcdefghijklmnop",
		"moz-extension://0f4e4d6c-6a0c-4a40-9a8b-2b6d0c0c5b11",
	])("lets %s read the host-branding route", async (origin) => {
		const response = await get(EXTENSION_CORS_PATH, origin);
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe(origin);
		expect(response.headers.get("vary")).toContain("Origin");
		expect(response.headers.get("access-control-allow-credentials")).toBeNull();
		expect(await response.json()).toEqual({ appName: null });
	});

	it("gives a web page on another origin no CORS headers", async () => {
		for (const origin of [
			"https://evil.example",
			"http://localhost:3000",
			"null",
			"chrome-extension://x/evil",
			"chrome-extension://",
		]) {
			const response = await get(EXTENSION_CORS_PATH, origin);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
			expect(response.headers.get("vary")).toContain("Origin");
		}
	});

	it("adds nothing when the request has no Origin header", async () => {
		const response = await get(EXTENSION_CORS_PATH);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("answers a preflight from an extension with the read methods only", async () => {
		const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
		const response = await app.request(EXTENSION_CORS_PATH, {
			method: "OPTIONS",
			headers: { origin, "access-control-request-method": "GET" },
		});
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe(origin);
		expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
		expect(response.headers.get("access-control-allow-credentials")).toBeNull();
	});

	it("does not answer a preflight from another origin", async () => {
		const response = await app.request(EXTENSION_CORS_PATH, {
			method: "OPTIONS",
			headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
		});
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("leaves every other route's CORS unchanged", async () => {
		const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
		for (const path of ["/api/openapi/branding/public/acme", "/api/openapi/resumes"]) {
			const response = await get(path, origin);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
		}
	});
});
