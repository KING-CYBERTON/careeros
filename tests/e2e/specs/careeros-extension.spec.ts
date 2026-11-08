import type { BrandingSeed, HostOrgs } from "../fixtures/org-hosts";
import type { BrowserContext, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { createHostOrgs, ORG_HOST_PATTERN, orgHostsConfigured, send } from "../fixtures/org-hosts";
import { expect, test } from "../fixtures/test";

// P5-T01: the Job Clipper extension. A development build of apps/extension is loaded unpacked into Chromium; the popup
// is opened as a page of the extension. The user enters an organization's address, sees that organization's name and
// logo, and confirms. The server must run with ORG_HOST_PATTERN={slug}.orgs.test (the CI e2e job sets it); the browser
// reaches organization hosts through a host-resolver rule.
//
// What the test cannot do: click the browser's own "allow access to this site" prompt, which is not part of the page.
// The test replaces `chrome.permissions.request` in the popup with one that answers yes. The popup's check of the
// organization (which comes before any permission request) relies on the server's CORS for extension origins (apps/server/src/http/extension-cors.ts), which
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

// P5-T03: the pages the clipper reads. The test cannot grant `activeTab` (the browser does that when the member clicks the
// toolbar button), so the popup's `tabs.query` and `scripting.executeScript` are replaced by shims; the shim runs the
// popup's own reader function, unchanged, in a real page of the local job site.
const JSON_LD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Senior Backend Engineer | Aurora Analytics</title>
<script type="application/ld+json">${JSON.stringify({
	"@context": "https://schema.org",
	"@type": "JobPosting",
	title: "Senior Backend Engineer",
	description: "<p>Build <b>reliable</b> services.</p><ul><li>TypeScript</li><li>PostgreSQL</li></ul>",
	datePosted: "2026-11-01",
	employmentType: "FULL_TIME",
	hiringOrganization: { "@type": "Organization", name: "Aurora Analytics" },
	jobLocation: {
		"@type": "Place",
		address: { "@type": "PostalAddress", addressLocality: "Nairobi", addressCountry: "KE" },
	},
	baseSalary: {
		"@type": "MonetaryAmount",
		currency: "KES",
		value: { "@type": "QuantitativeValue", minValue: 250000, maxValue: 400000, unitText: "MONTH" },
	},
}).replaceAll(
	"<",
	"\\u003c",
)}</script></head><body><main><h1>Senior Backend Engineer</h1><p>Build reliable services.</p></main></body></html>`;
const PLAIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Careers</title>
<meta property="og:title" content="Customer Success Manager"></head>
<body><main><h1>Customer Success Manager</h1><p>Help customers succeed. Onboarding and renewals.</p></main></body></html>`;

test.describe("job clipper extension", () => {
	let workspace: string;
	let extensionDir: string;
	let orgs: HostOrgs;
	let context: BrowserContext;
	let extensionId: string;
	let otherServer: Server;
	let otherOrigin: string;
	let jobServer: Server;
	let jobOrigin: string;

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

		// P5-T03: a local "job site": one page with JobPosting JSON-LD and one without (every name here is made up).
		jobServer = createServer((request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(request.url?.startsWith("/plain") ? PLAIN_PAGE : JSON_LD_PAGE);
		});
		await new Promise<void>((resolve) => jobServer.listen(0, "127.0.0.1", resolve));
		const jobAddress = jobServer.address();
		jobOrigin = `http://localhost:${typeof jobAddress === "object" && jobAddress ? jobAddress.port : 0}`;

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
		await new Promise<void>((resolve) => (jobServer ? jobServer.close(() => resolve()) : resolve()));
		await orgs?.dispose();
		if (workspace) rmSync(workspace, { recursive: true, force: true });
	});

	async function openPopup(): Promise<Page> {
		const page = await context.newPage();
		await page.setViewportSize({ width: 360, height: 600 });
		// The browser's permission prompt is not driveable; see the note at the top of this file.
		await page.addInitScript(() => {
			type Api = { permissions: { request: (request: { origins: string[] }) => Promise<boolean> } };
			const scope = globalThis as unknown as { chrome: Api; permissionRequests: string[][] };
			scope.permissionRequests = [];
			scope.chrome.permissions.request = (request) => {
				scope.permissionRequests.push(request.origins);
				return Promise.resolve(true);
			};
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
		// The check needed no host permission: none was asked for before the user confirms.
		expect(
			await page.evaluate(() => (globalThis as unknown as { permissionRequests: string[][] }).permissionRequests),
		).toEqual([]);
		await expect(page.getByText(SEED.appName)).toBeVisible();
		await expect(page.getByText(orgs.a.origin)).toBeVisible();
		const logo = page.getByRole("img", { name: `${SEED.appName} logo` });
		await expect(logo).toBeVisible();
		// The image is drawn: it loaded from the organization's host, which the page policy and the server's answer allow.
		await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
		expect(await logo.getAttribute("src")).toMatch(new RegExp(`^${orgs.a.origin}/api/branding-assets/`));

		await page.getByRole("button", { name: "Yes, connect" }).click();
		await expect(page.getByRole("heading", { name: SEED.appName })).toBeVisible();
		// Asked for exactly the one origin, after the confirmation.
		expect(
			await page.evaluate(() => (globalThis as unknown as { permissionRequests: string[][] }).permissionRequests),
		).toEqual([[`${orgs.a.origin}/*`]]);
		await expect(page.getByText("Connected to")).toBeVisible();
		// The header takes the organization's colour.
		await expect(page.locator("header")).toHaveCSS("background-color", "rgb(200, 40, 60)");
		// Not signed in yet: a Sign in button (P5-T02).
		await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
		await page.close();
	});

	test("signing in: the popup shows a code, a member approves it, and the popup says who is signed in", async ({
		playwright,
		baseURL,
	}) => {
		test.setTimeout(90_000);
		const server = baseURL ?? "http://localhost:3000";
		const page = await openPopup();
		await page.getByRole("button", { name: "Sign in" }).click();
		// The code arrives after one request to the organization's host; a failure shows a notice instead.
		await expect(page.getByTestId("user-code")).toBeVisible({ timeout: 15_000 });
		const shown = (await page.getByTestId("user-code").textContent()) ?? "";
		const userCode = shown.replaceAll("-", "").trim();
		expect(userCode).toMatch(/^[A-Z0-9]{8}$/);

		// A member opens the approval page on the organization's host and approves: review the code, then approve it.
		const common = { host: orgs.a.host, origin: orgs.a.origin, cookie: orgs.a.member.cookie };
		const reviewed = await send(playwright, server, {
			...common,
			method: "GET",
			path: `/api/auth/device?user_code=${userCode}`,
		});
		expect(reviewed.response.status()).toBe(200);
		const approved = await send(playwright, server, {
			...common,
			method: "POST",
			path: "/api/auth/device/approve",
			data: { userCode },
		});
		expect(approved.response.status()).toBe(200);

		// The popup polls every 5 seconds and ends on "Signed in as <name>".
		await expect(page.getByTestId("signed-in-as")).toContainText("Signed in as", { timeout: 40_000 });

		// Sign out revokes the token on the server and forgets it here.
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
		await page.close();
	});

	/** The popup with the tab shims: it reads the fixture page as if it were the member's active tab. */
	async function openClipPopup(fixturePath: string): Promise<{ page: Page; opened: () => Promise<string[]> }> {
		const fixture = await context.newPage();
		await fixture.goto(`${jobOrigin}${fixturePath}`);
		const page = await context.newPage();
		await page.setViewportSize({ width: 360, height: 700 });
		await page.exposeFunction("readFixture", (source: string) => fixture.evaluate(`(${source})()`));
		await page.addInitScript((url) => {
			type Shim = {
				tabs: { query: unknown; create: unknown };
				scripting: { executeScript: unknown };
				permissions: { request: unknown };
			};
			const scope = globalThis as unknown as {
				chrome: Shim;
				readFixture: (source: string) => Promise<unknown>;
				openedTabs: string[];
			};
			scope.openedTabs = [];
			scope.chrome.permissions.request = () => Promise.resolve(true);
			scope.chrome.tabs.query = () => Promise.resolve([{ id: 1, url }]);
			scope.chrome.tabs.create = (properties: { url: string }) => {
				scope.openedTabs.push(properties.url);
				return Promise.resolve({});
			};
			scope.chrome.scripting.executeScript = async (injection: { func: () => unknown }) => [
				{ result: await scope.readFixture(injection.func.toString()) },
			];
		}, `${jobOrigin}${fixturePath}`);
		await page.goto(`chrome-extension://${extensionId}/popup.html`);
		page.on("close", () => void fixture.close());
		return { page, opened: () => page.evaluate(() => (globalThis as unknown as { openedTabs: string[] }).openedTabs) };
	}

	async function signInPopup(page: Page, playwright: Parameters<typeof send>[0], server: string) {
		await page.getByRole("button", { name: "Sign in" }).click();
		await expect(page.getByTestId("user-code")).toBeVisible({ timeout: 15_000 });
		const userCode = ((await page.getByTestId("user-code").textContent()) ?? "").replaceAll("-", "").trim();
		const common = { host: orgs.a.host, origin: orgs.a.origin, cookie: orgs.a.member.cookie };
		await send(playwright, server, { ...common, method: "GET", path: `/api/auth/device?user_code=${userCode}` });
		const approved = await send(playwright, server, {
			...common,
			method: "POST",
			path: "/api/auth/device/approve",
			data: { userCode },
		});
		expect(approved.response.status()).toBe(200);
		await expect(page.getByTestId("signed-in-as")).toContainText("Signed in as", { timeout: 40_000 });
	}

	test("clipping a job: read the page, confirm, save, and see it in the web tracker", async ({
		browser,
		playwright,
		baseURL,
	}) => {
		test.setTimeout(150_000);
		const server = baseURL ?? "http://localhost:3000";
		const { page, opened } = await openClipPopup("/job");
		await signInPopup(page, playwright, server);

		// The form is filled from the page's JSON-LD, and says so.
		await expect(page.getByTestId("clip-origin")).toHaveText("Found on the page");
		await expect(page.getByLabel("Job title")).toHaveValue("Senior Backend Engineer");
		await expect(page.getByLabel("Company")).toHaveValue("Aurora Analytics");
		await expect(page.getByLabel("Location")).toHaveValue("Nairobi, KE");
		await expect(page.getByLabel("Salary")).toHaveValue("KES 250,000 - 400,000 per month");
		await expect(page.getByLabel("Link to the posting")).toHaveValue(`${jobOrigin}/job`);
		await expect(page.getByLabel("Description")).toHaveValue(/Build reliable services\./);
		await expect(page.getByTestId("clip-duplicate")).toHaveCount(0);

		// The member confirms (here: corrects the location) and saves.
		await page.getByLabel("Location").fill("Nairobi (hybrid)");
		await page.getByRole("button", { name: "Save to tracker" }).click();
		await expect(page.getByTestId("clip-saved")).toBeVisible({ timeout: 20_000 });
		await page.getByRole("button", { name: "Open in your tracker" }).click();
		const link = (await opened()).at(-1) ?? "";
		expect(link).toMatch(new RegExp(`^${orgs.a.origin}/dashboard/applications\\?applicationId=`));

		// The web tracker, as the member, shows the job on the organization's host.
		const memberContext = await browser.newContext({ colorScheme: "light" });
		try {
			const [name = "", ...rest] = orgs.a.member.cookie.split("; ")[0]?.split("=") ?? [];
			await memberContext.addCookies([
				{ name, value: rest.join("="), domain: orgs.a.host, path: "/", httpOnly: true, sameSite: "Lax" },
			]);
			const tracker = await memberContext.newPage();
			await tracker.goto(link);
			await expect(tracker.getByText("Aurora Analytics").first()).toBeVisible({ timeout: 30_000 });
			await expect(tracker.getByText("Senior Backend Engineer").first()).toBeVisible();
		} finally {
			await memberContext.close();
		}
		await page.close();

		// The same page again: the tracker already has it, and says so, and saving is still possible.
		const again = await openClipPopup("/job");
		await expect(again.page.getByTestId("clip-duplicate")).toContainText("Already in your tracker", {
			timeout: 20_000,
		});
		await expect(again.page.getByRole("button", { name: "Save anyway" })).toBeEnabled();
		await again.page.close();
	});

	test("a page without JSON-LD is a best guess, saved after the member's edits", async ({ playwright, baseURL }) => {
		test.setTimeout(90_000);
		const { page } = await openClipPopup("/plain");
		// The sign-in from the previous test is still stored: the form is there at once.
		await expect(page.getByTestId("clip-origin")).toHaveText("Best guess");
		await expect(page.getByLabel("Job title")).toHaveValue("Customer Success Manager");
		await expect(page.getByLabel("Company")).toHaveValue("");

		// A company is required: saving without one keeps the form and says what is missing.
		await page.getByRole("button", { name: "Save to tracker" }).click();
		await expect(page.getByText("Add a job title and a company to save.")).toBeVisible();
		await page.getByLabel("Company").fill("Cedar Software");
		await page.getByRole("button", { name: "Save to tracker" }).click();
		await expect(page.getByTestId("clip-saved")).toBeVisible({ timeout: 20_000 });

		const listed = await send(playwright, baseURL ?? "http://localhost:3000", {
			host: orgs.a.host,
			origin: orgs.a.origin,
			cookie: orgs.a.member.cookie,
			method: "GET",
			path: "/api/openapi/applications",
		});
		expect(listed.body).toContain("Cedar Software");
		expect(listed.body).toContain("clipper");

		// Sign out so the next test starts from the connected, signed-out popup.
		await page.reload();
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
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
