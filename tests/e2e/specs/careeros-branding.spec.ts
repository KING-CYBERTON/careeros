import type { BrandingSeed, HostOrgs, HostOrgSeed } from "../fixtures/org-hosts";
import type { Browser, Page } from "@playwright/test";
import {
	createHostOrgs,
	ORG_HOST_LAUNCH_OPTIONS,
	ORG_HOST_PATTERN,
	orgHostsConfigured,
	readBrandingFixture,
	send,
} from "../fixtures/org-hosts";
import { waitForLoggedMail } from "../fixtures/server-log";
import { expect, test } from "../fixtures/test";

// P2-Q02: two organizations on two hosts each show their own brand on every surface the phase plan names: the sign-in
// page, the app shell, the title and favicon, a public resume, the password-reset email, and the raw HTML (which must
// carry nothing of the other organization). The server must run with ORG_HOST_PATTERN={slug}.orgs.test (the CI e2e job
// sets it). Organization hosts are reached with a Host header for raw responses and a Chromium host-resolver rule for
// the browser.
//
// How the branding is set: the settings UI (P2-T07) is not what this spec proves, so the text fields (name, primary
// colour, sender name) go in through SQL with `withSeedPool`, and the logo and favicon (PNG fixtures in
// fixtures/branding/) through the real upload endpoints, since an asset needs a stored file. Once T07 has merged,
// Organization A's setup can move to the settings page (see docs/questions.md Q154).
test.skip(
	!orgHostsConfigured(),
	`needs the e2e server to run with ORG_HOST_PATTERN=${ORG_HOST_PATTERN} (the CI e2e job sets it)`,
);
test.use({ launchOptions: ORG_HOST_LAUNCH_OPTIONS, colorScheme: "light" });

const sessionCookie = (header: string) => {
	const [name = "", ...rest] = header.split("; ")[0]?.split("=") ?? [];
	return { name, value: rest.join("=") };
};

test.describe("organization branding", () => {
	test.describe.configure({ mode: "serial" });

	let orgs: HostOrgs;
	let baseURL: string;
	let names: { a: string; b: string };
	let resumePaths: { a: string; b: string };

	const orgs2 = () => [orgs.a, orgs.b] as const;
	const other = (org: HostOrgSeed) => (org === orgs.a ? orgs.b : orgs.a);
	const assetsOf = (org: HostOrgSeed) => {
		if (!org.assets || !org.branding) throw new Error(`${org.host} has no branding`);
		return { ...org.assets, ...org.branding };
	};

	test.beforeAll(async ({ playwright }, testInfo) => {
		test.setTimeout(120_000);
		baseURL = String(testInfo.project.use.baseURL ?? "http://localhost:3000");
		const run = Math.random().toString(36).slice(2, 8);
		names = { a: `Aurora ${run}`, b: `Borealis ${run}` };
		const seedA: BrandingSeed = {
			appName: names.a,
			primaryColor: "#c8283c",
			emailFromName: `Aurora Careers ${run}`,
			logoFile: "org-a-logo.png",
			faviconFile: "org-a-favicon.png",
		};
		const seedB: BrandingSeed = {
			appName: names.b,
			primaryColor: "#146ec8",
			emailFromName: `Borealis Careers ${run}`,
			logoFile: "org-b-logo.png",
			faviconFile: "org-b-favicon.png",
		};
		orgs = await createHostOrgs(playwright, baseURL, { prefix: "br", branding: { a: seedA, b: seedB } });

		// A public resume of a member of each organization, served on that organization's host.
		const paths: Record<string, string> = {};
		for (const org of orgs2()) {
			const slug = `brand-${org === orgs.a ? "a" : "b"}-${run}`;
			const created = await send(playwright, baseURL, {
				method: "POST",
				path: "/api/openapi/resumes",
				host: org.host,
				origin: org.origin,
				cookie: org.member.cookie,
				data: { name: `Brand resume ${slug}`, slug, tags: [] },
			});
			expect(created.response.status(), created.body).toBe(200);
			const shared = await send(playwright, baseURL, {
				method: "PUT",
				path: `/api/openapi/resumes/${JSON.parse(created.body) as string}`,
				host: org.host,
				origin: org.origin,
				cookie: org.member.cookie,
				data: { isPublic: true },
			});
			expect(shared.response.status(), shared.body).toBe(200);
			paths[org === orgs.a ? "a" : "b"] = `/${org.member.account.username}/${slug}`;
		}
		resumePaths = { a: paths.a ?? "", b: paths.b ?? "" };
	});

	test.afterAll(async () => {
		await orgs?.dispose();
	});

	const get = (playwright: Parameters<typeof send>[0], org: HostOrgSeed, path: string, cookie?: string) =>
		send(playwright, baseURL, { method: "GET", path, host: org.host, ...(cookie ? { cookie } : {}) });

	/** A browser context for an organization's host, optionally signed in as its owner. */
	async function openOrgPage(browser: Browser, org: HostOrgSeed, signedIn: boolean) {
		const context = await browser.newContext({ colorScheme: "light" });
		if (signedIn) {
			const { name, value } = sessionCookie(org.owner.cookie);
			await context.addCookies([
				{ name, value, domain: `${org.slug}.orgs.test`, path: "/", httpOnly: true, sameSite: "Lax" },
			]);
		}
		return { context, page: await context.newPage() };
	}

	async function expectLoadedImage(page: Page, src: string) {
		const image = page.locator(`img[src="${src}"]`).first();
		await expect(image).toBeVisible({ timeout: 20_000 });
		// The asset is really served: the browser decoded it.
		await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
	}

	for (const key of ["a", "b"] as const) {
		const label = key === "a" ? "Organization A" : "Organization B";

		test(`${label}: sign-in page shows its name and logo, title and favicon`, async ({ browser }) => {
			test.setTimeout(60_000);
			const org = orgs[key];
			const brand = assetsOf(org);
			const { context, page } = await openOrgPage(browser, org, false);
			try {
				await page.goto(`${org.origin}/auth/login`);
				await expect(page.getByText(brand.appName, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
				await expectLoadedImage(page, brand.logoPath);
				await expect.poll(() => page.title()).toContain(brand.appName);
				const favicon = await page.locator('link[rel="icon"]').first().getAttribute("href");
				expect(favicon).toBe(brand.faviconPath);
				const wrong = other(org);
				expect(await page.content()).not.toContain(assetsOf(wrong).appName);
			} finally {
				await context.close();
			}
		});

		test(`${label}: the app shell after sign-in shows its name and logo and sets its accent colour`, async ({
			browser,
		}) => {
			test.setTimeout(60_000);
			const org = orgs[key];
			const brand = assetsOf(org);
			const { context, page } = await openOrgPage(browser, org, true);
			try {
				await page.goto(`${org.origin}/dashboard`);
				await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
				await expect(page.getByText(brand.appName, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
				await expectLoadedImage(page, brand.logoPath);
				const accent = await page.evaluate(() =>
					getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase(),
				);
				expect(accent).toBe(brand.primaryColor);
				await expect.poll(() => page.title()).toContain(brand.appName);
				expect(await page.locator('link[rel="icon"]').first().getAttribute("href")).toBe(brand.faviconPath);
			} finally {
				await context.close();
			}
		});

		test(`${label}: a member's public resume carries its name and favicon`, async ({ playwright }) => {
			const org = orgs[key];
			const brand = assetsOf(org);
			const page = await get(playwright, org, resumePaths[key]);
			expect(page.response.status(), page.body.slice(0, 200)).toBe(200);
			expect(page.body).toContain(brand.appName);
			expect(page.body).toContain(`<link rel="icon" href="${brand.faviconPath}"`);
			const wrong = assetsOf(other(org));
			expect(page.body).not.toContain(wrong.appName);
			expect(page.body).not.toContain(wrong.faviconPath);
		});

		test(`${label}: a password reset requested on its host is sent in its name`, async ({ playwright }) => {
			const org = orgs[key];
			const brand = assetsOf(org);
			const reset = await send(playwright, baseURL, {
				method: "POST",
				path: "/api/auth/request-password-reset",
				host: org.host,
				origin: org.origin,
				data: { email: org.member.account.email, redirectTo: `${org.origin}/auth/reset-password` },
			});
			expect(reset.response.status(), reset.body).toBe(200);
			// Only the recipient and subject reach the e2e server's log. The sender name and the link's host are asserted
			// in packages/auth/src/email-brand.test.ts and email-links.integration.test.ts (docs/questions.md Q150).
			const mail = await waitForLoggedMail(org.member.account.email, "Reset your ");
			expect(mail.subject).toBe(`Reset your ${brand.appName} password`);
			expect(mail.subject).not.toContain(assetsOf(other(org)).appName);
		});
	}

	test("the raw HTML of each host carries nothing of the other organization", async ({ playwright }) => {
		const pages = ["/auth/login", "/dashboard", "/manifest.webmanifest"];
		for (const org of orgs2()) {
			const brand = assetsOf(org);
			const wrong = assetsOf(other(org));
			const responses = [
				...(await Promise.all(pages.map(async (path) => ({ path, ...(await get(playwright, org, path)) })))),
				{
					path: resumePaths[org === orgs.a ? "a" : "b"],
					...(await get(playwright, org, resumePaths[org === orgs.a ? "a" : "b"])),
				},
			];
			for (const { path, response, body } of responses) {
				const where = `${org.host}${path}`;
				expect(response.status(), where).toBe(200);
				expect(body, `${where} carries its own name`).toContain(brand.appName);
				// The other organization's name, colour, asset paths, host and id never appear.
				expect(body, `${where} carries the other organization's name`).not.toContain(wrong.appName);
				expect(body.toLowerCase(), `${where} carries the other organization's colour`).not.toContain(
					wrong.primaryColor,
				);
				expect(body, `${where} carries the other organization's logo`).not.toContain(wrong.logoPath);
				expect(body, `${where} carries the other organization's favicon`).not.toContain(wrong.faviconPath);
				expect(body, `${where} names the other organization's host`).not.toContain(other(org).slug);
				expect(body, `${where} names the other organization's id`).not.toContain(other(org).id);
			}
			// The shell carries the colour in the brand block, and the favicon and logo paths of its own organization.
			const shell = responses[0]?.body ?? "";
			expect(shell.toLowerCase()).toContain(`--accent:${brand.primaryColor}`);
			expect(shell).toContain(brand.logoPath);
			expect(shell).toContain(brand.faviconPath);
		}
	});

	test("each organization's logo and favicon are served from its own path, and only there", async ({ playwright }) => {
		for (const org of orgs2()) {
			const brand = assetsOf(org);
			const wrong = assetsOf(other(org));
			const logo = await get(playwright, org, brand.logoPath);
			expect(logo.response.status()).toBe(200);
			expect(logo.response.headers()["content-type"]).toBe("image/png");
			// The bytes are the fixture this organization uploaded, not the other's.
			const { bytes } = logo;
			expect(Buffer.compare(bytes, readBrandingFixture(brand.logoFile))).toBe(0);
			expect(Buffer.compare(bytes, readBrandingFixture(wrong.logoFile))).not.toBe(0);
			// The other organization's asset path is never one of this organization's files.
			const crossed = await get(playwright, org, brand.logoPath.replace(org.id, other(org).id));
			expect(crossed.response.status()).toBe(404);
		}
	});

	test("branded responses vary on Host, so no cache serves one organization's page to another", async ({
		playwright,
	}) => {
		const vary = (header: string | undefined) => (header ?? "").split(",").map((value) => value.trim().toLowerCase());
		for (const org of orgs2()) {
			const paths = ["/auth/login", "/dashboard", "/manifest.webmanifest", resumePaths[org === orgs.a ? "a" : "b"]];
			for (const path of paths) {
				const { response } = await get(playwright, org, path);
				expect(vary(response.headers().vary), `${org.host}${path} Vary`).toContain("host");
			}
		}
	});
});
