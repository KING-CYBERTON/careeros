import { randomUUID } from "node:crypto";
import { createAuthenticatedContext } from "../fixtures/auth";
import { createInviteeAccount, deleteE2EOrganizations } from "../fixtures/careeros-org";
import { deleteE2EUser } from "../fixtures/db";
import { withSeedPool } from "../fixtures/seed-db";
import { expect, test } from "../fixtures/test";

// P2-T07: an owner changes the organization's brand from Settings → Branding and the organization's own address serves
// it; a plain member cannot open the screen; the Domains screen shows what a server without Cloudflare can.
// The branding part needs the server to run with ORG_HOST_PATTERN={slug}.orgs.test (the CI e2e job sets it); the
// browser reaches that host through a Chromium host-resolver rule. The member and Domains checks need no pattern.
const PATTERN = "{slug}.orgs.test";
const hasPattern = process.env.ORG_HOST_PATTERN === PATTERN;
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP *.orgs.test 127.0.0.1"] } });

const organizationOf = (email: string) =>
	withSeedPool(async (pool) => {
		const { rows } = await pool.query<{ id: string; slug: string }>(
			`select o.id, o.slug from organization o join member m on m.organization_id = o.id
			 join "user" u on u.id = m.user_id where u.email = $1 order by o.created_at limit 1`,
			[email],
		);
		const row = rows[0];
		if (!row) throw new Error("The account has no organization.");
		return row;
	});

test("an owner changes the app name and primary colour, and the organization's address serves them", async ({
	authPage: page,
	account,
	browser,
}, testInfo) => {
	test.skip(!hasPattern, `needs the server to run with ORG_HOST_PATTERN=${PATTERN}`);
	const org = await organizationOf(account.email);
	const name = `Acme ${randomUUID().slice(0, 6)}`;

	await page.goto("/dashboard/settings/branding");
	await expect(page.getByRole("heading", { name: "Branding" })).toBeVisible();
	await page.getByLabel("App name").fill(name);
	await page.getByLabel("Primary colour", { exact: true }).fill("#c2410c");
	await expect(page.getByTestId("brand-preview-name")).toHaveText(name);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByText(/Branding saved/)).toBeVisible();

	// The organization's own address, signed out: the title and the accent token come from the stored branding.
	const baseURL = String(testInfo.project.use.baseURL ?? "http://localhost:3000");
	const port = new URL(baseURL).port || "80";
	const context = await browser.newContext();
	try {
		const orgPage = await context.newPage();
		await orgPage.goto(`http://${org.slug}.orgs.test:${port}/auth/login`);
		await expect(orgPage).toHaveTitle(new RegExp(name));
		const accent = await orgPage.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
		);
		expect(accent.toLowerCase()).toBe("#c2410c");
	} finally {
		await context.close();
	}
});

test("a member who is not an owner or admin cannot open Settings → Branding", async ({
	authPage: owner,
	account,
	browser,
	playwright,
}, testInfo) => {
	const baseURL = String(testInfo.project.use.baseURL ?? "http://localhost:3000");
	const member = createInviteeAccount(account);
	const request = await playwright.request.newContext({ baseURL });
	try {
		const org = await organizationOf(account.email);
		const memberContext = await createAuthenticatedContext(browser, request, member, baseURL);
		await withSeedPool(async (pool) => {
			const { rows } = await pool.query<{ id: string }>('select id from "user" where email = $1', [member.email]);
			await pool.query("insert into member (id, organization_id, user_id, role) values ($1, $2, $3, 'member')", [
				`m-${randomUUID().slice(0, 8)}`,
				org.id,
				rows[0]?.id,
			]);
		});
		const page = await memberContext.newPage();
		// Work in the owner's organization: the server checks the membership and the role on every call.
		const switched = await memberContext.request.post("/api/auth/organization/set-active", {
			data: { organizationId: org.id },
			headers: { origin: baseURL },
		});
		expect(switched.ok()).toBe(true);
		await page.goto("/dashboard/settings");
		await expect(page.getByRole("link", { name: "Branding" })).toBeHidden();
		await page.goto("/dashboard/settings/branding");
		await page.waitForURL(/\/dashboard\/settings\/?$/);
		await expect(page.getByLabel("App name")).toBeHidden();

		// The API refuses them regardless of the screen.
		const refused = await memberContext.request.patch("/api/openapi/branding", {
			data: { appName: "Hijack" },
			headers: { origin: baseURL },
		});
		expect(refused.status()).toBe(403);

		// The owner still sees it.
		await owner.goto("/dashboard/settings");
		await expect(owner.getByRole("link", { name: "Branding" })).toBeVisible();
	} finally {
		await request.dispose();
		await deleteE2EOrganizations([account, member]);
		await deleteE2EUser(member);
	}
});

test("the Domains screen shows the organization's address, and says so when custom domains are not set up", async ({
	authPage: page,
	account,
}) => {
	const org = await organizationOf(account.email);
	await page.goto("/dashboard/settings/domains");
	await expect(page.getByRole("heading", { name: "Domains" })).toBeVisible();
	if (hasPattern) await expect(page.getByTestId("subdomain-host")).toHaveText(`${org.slug}.orgs.test`);
	// CI has no Cloudflare credentials, so adding a domain (and with it the DNS records step) is not offered.
	await expect(page.getByTestId("domains-not-configured")).toBeVisible();
	await expect(page.getByRole("button", { name: "Add domain" })).toHaveCount(0);
});
