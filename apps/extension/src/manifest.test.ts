import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { buildManifest } from "./manifest";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
	version: string;
};

// The build writes exactly what buildManifest returns (vite.config.ts), so this is the built manifest.
describe("production manifest", () => {
	const manifest = buildManifest({ version });

	it("is Manifest V3 and takes its version from package.json", () => {
		expect(manifest.manifest_version).toBe(3);
		expect(manifest.version).toBe(version);
	});

	it("carries no product brand", () => {
		expect(manifest.name).toBe("Job Clipper");
		expect(JSON.stringify(manifest).toLowerCase()).not.toContain("careeros");
		expect(JSON.stringify(manifest).toLowerCase()).not.toContain("reactive");
	});

	it("asks for exactly activeTab, storage and scripting", () => {
		expect([...manifest.permissions].sort()).toEqual(["activeTab", "scripting", "storage"]);
	});

	it("grants no host access at install and lists https as optional only", () => {
		expect(manifest).not.toHaveProperty("host_permissions");
		expect(manifest).not.toHaveProperty("content_scripts");
		expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
	});

	it("has a popup and a service worker", () => {
		expect(manifest.action.default_popup).toBe("popup.html");
		expect(manifest.background.service_worker).toBe("service-worker.js");
	});

	it("has a strict page policy: own scripts only, no eval, no http", () => {
		const policy = manifest.content_security_policy.extension_pages;
		expect(policy).toContain("script-src 'self'");
		expect(policy).not.toContain("unsafe-eval");
		expect(policy).not.toContain("unsafe-inline");
		expect(policy).not.toContain("wasm-unsafe-eval");
		expect(policy).not.toMatch(/http:/);
		expect(policy.match(/script-src[^;]*/)?.[0]).toBe("script-src 'self'");
	});

	it("names icon files for every size", () => {
		expect(Object.keys(manifest.icons)).toEqual(["16", "32", "48", "128"]);
	});
});

describe("development manifest", () => {
	it("adds the listed http hosts as optional host permissions and policy sources, and nothing else", () => {
		const manifest = buildManifest({ version, devHttpHosts: ["localhost", "*.orgs.test"] });
		expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://localhost/*", "http://*.orgs.test/*"]);
		expect([...manifest.permissions].sort()).toEqual(["activeTab", "scripting", "storage"]);
		expect(manifest.content_security_policy.extension_pages).toContain("connect-src https: http://localhost:*");
	});
});
