import type { BrandingSeed, HostOrgs } from "../fixtures/org-hosts";
import type { BrowserContext, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { createHostOrgs, ORG_HOST_PATTERN, orgHostsConfigured } from "../fixtures/org-hosts";
import { expect, test } from "../fixtures/test";

// P5-T01: the Job Clipper extension. A development build of apps/extension is loaded unpacked into Chromium; the popup
// is opened as a page of the extension. The user enters an organization's address, sees that organization's name and
// logo, and confirms. The server must run with ORG_HOST_PATTERN={slug}.orgs.test (the CI e2e job sets it); the browser
// reaches organization hosts through a host-resolver rule.
//
// What the test cannot do: click the browser's own "allow access to this site" prompt, which is not part of the page.
// The test replaces `chrome.permissions.request` in the popup with one that answers yes. The popup's request to the
// organization then relies on the server's CORS for extension origins (apps/server/src/http/extension-cors.ts), which
// is what this test proves for the real server.
test.skip(
	!orgHostsConfigured(),
	`needs the e2e server to run with ORG_HOST_PATTERN=${ORG_HOST_PATTERN} (the CI e2e job sets it)`,
);
test.describe.configure({ mode: "serial" });

const SEED: BrandingSeed = {
	appName: "Aurora Careers",
	primaryColor: "#c8283c",
	emailFromName: "Aurora Careers",
	logoFile: "org-a-logo.png",
	faviconFile: "org-a-favicon.png",
};

test.describe("job clipper extension", () => {
	let workspace: string;
	let extensionDir: string;
	let orgs: HostOrgs;
	let context: BrowserContext;
	let extensionId: string;
	let otherServer: Server;
	let otherOrigin: string;

	test.beforeAll(async ({ playwright }, testInfo) => {
		test.setTimeout(180_000);
		workspace = mkdtempSync(join(tmpdir(), "job-clipper-e2e-"));
		extensionDir = join(workspace, "extension");

		// A development build that may reach http://localhost and http://*.orgs.test (a production build reaches no http host).
		execFileSync("pnpm", ["exec", "vp", "build", "--mode", "development", "--outDir", extensionDir, "--emptyOutDir"], {
			cwd: join(process.cwd(), "apps", "extension"),
			env: { ...process.env, EXTENSION_DEV_HTTP_HOSTS: "localhost,*.orgs.test" },
			stdio: "pipe",
		});

		const baseURL = String(testInfo.project.use.baseURL ?? "http://localhost:3000");
		orgs = await createHostOrgs(playwright, baseURL, {
			prefix: "ext",
			branding: { a: SEED, b: { ...SEED, appName: "Borealis Careers" } },
		});

		// A server that is not CareerOS: it answers every path with JSON of another shape.
		otherServer = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
			response.end(JSON.stringify({ status: "ok", service: "something else" }));
		});
		await new Promise<void>((resolve) => otherServer.listen(0, "127.0.0.1", resolve));
		const address = otherServer.address();
		otherOrigin = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;

		context = await chromium.launchPersistentContext(join(workspace, "profile"), {
			channel: "chromium",
			headless: true,
			args: [
				`--disable-extensions-except=${extensionDir}`,
				`--load-extension=${extensionDir}`,
				"--host-resolver-rules=MAP *.orgs.test 127.0.0.1",
			],
		});
		const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
		extensionId = new URL(worker.url()).host;
	});

	test.afterAll(async () => {
		await context?.close();
		await new Promise<void>((resolve) => (otherServer ? otherServer.close(() => resolve()) : resolve()));
		await orgs?.dispose();
		if (workspace) rmSync(workspace, { recursive: true, force: true });
	});

	async function openPopup(): Promise<Page> {
		const page = await context.newPage();
		await page.setViewportSize({ width: 360, height: 600 });
		// The browser's permission prompt is not driveable; see the note at the top of this file.
		await page.addInitScript(() => {
			const extensionApi = (globalThis as unknown as { chrome: { permissions: { request: () => Promise<boolean> } } })
				.chrome;
			extensionApi.permissions.request = () => Promise.resolve(true);
		});
		await page.goto(`chrome-extension://${extensionId}/popup.html`);
		return page;
	}

	test("the built manifest asks for activeTab, storage and scripting only, and no host access", () => {
		const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8")) as {
			name: string;
			permissions: string[];
			host_permissions?: string[];
			optional_host_permissions: string[];
		};
		expect(manifest.name).toBe("Job Clipper");
		expect([...manifest.permissions].sort()).toEqual(["activeTab", "scripting", "storage"]);
		expect(manifest.host_permissions).toBeUndefined();
		expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://localhost/*", "http://*.orgs.test/*"]);
	});

	test("setup shows the organization's name and logo, then connects", async () => {
		const page = await openPopup();
		await expect(page.getByRole("heading", { name: "Connect to your organization" })).toBeVisible();

		await page.getByLabel("Your organization's address").fill(orgs.a.origin);
		await page.getByRole("button", { name: "Connect" }).click();

		await expect(page.getByRole("heading", { name: "Is this your organization?" })).toBeVisible();
		await expect(page.getByText(SEED.appName)).toBeVisible();
		await expect(page.getByText(orgs.a.origin)).toBeVisible();
		const logo = page.getByRole("img", { name: `${SEED.appName} logo` });
		await expect(logo).toBeVisible();
		// The image is drawn: it loaded from the organization's host, which the page policy and the server's answer allow.
		await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
		expect(await logo.getAttribute("src")).toMatch(new RegExp(`^${orgs.a.origin}/api/branding-assets/`));

		await page.getByRole("button", { name: "Yes, connect" }).click();
		await expect(page.getByRole("heading", { name: SEED.appName })).toBeVisible();
		await expect(page.getByText("Connected to")).toBeVisible();
		// The header takes the organization's colour.
		await expect(page.locator("header")).toHaveCSS("background-color", "rgb(200, 40, 60)");
		// Not signed in yet: a disabled button and a note.
		await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
		await page.close();
	});

	test("the connection survives a reopen, and Change organization clears it", async () => {
		const page = await openPopup();
		await expect(page.getByRole("heading", { name: SEED.appName })).toBeVisible();

		await page.getByRole("button", { name: "Change organization" }).click();
		await expect(page.getByRole("heading", { name: "Connect to your organization" })).toBeVisible();
		await page.reload();
		await expect(page.getByRole("heading", { name: "Connect to your organization" })).toBeVisible();
		await page.close();
	});

	test("an address that is not a CareerOS server is refused", async () => {
		const page = await openPopup();
		await page.getByLabel("Your organization's address").fill(otherOrigin);
		await page.getByRole("button", { name: "Connect" }).click();
		await expect(page.getByRole("alert")).toContainText("not a supported organization address");
		await expect(page.getByRole("heading", { name: "Is this your organization?" })).toHaveCount(0);
		await page.close();
	});

	test("the platform address, which belongs to no organization, is refused", async ({ baseURL }) => {
		const page = await openPopup();
		await page.getByLabel("Your organization's address").fill(String(baseURL));
		await page.getByRole("button", { name: "Connect" }).click();
		await expect(page.getByRole("alert")).toContainText("does not belong to an organization");
		await page.close();
	});

	test("an http address that is not a development host is refused before any request", async () => {
		const page = await openPopup();
		await page.getByLabel("Your organization's address").fill("http://careers.example.org");
		await page.getByRole("button", { name: "Connect" }).click();
		await expect(page.getByRole("alert")).toContainText("https://");
		await page.close();
	});
});
