import { accountOrganizationId } from "../fixtures/careeros-org";
import { orgHostsConfigured, send } from "../fixtures/org-hosts";
import { withSeedPool } from "../fixtures/seed-db";
import { expect, test } from "../fixtures/test";

// P3-T07: the Super Admin console. Only a platform admin with two-factor authentication gets in, only on the platform
// host, and everything an admin does is in the audit log. The admin role is granted in the database here, as the
// `tooling/careeros/platform-admin.mjs` command does in production; the two-factor flag is set the same way (the
// definer functions check it). Serial: the announcements are global, so each test ends the ones it created.
test.describe.configure({ mode: "serial" });

type Rpc = { json?: { code?: string; data?: { code?: string } } };

async function setRole(email: string, role: string, twoFactor: boolean) {
	await withSeedPool((pool) =>
		pool.query(`update "user" set role = $2, two_factor_enabled = $3 where email = $1`, [email, role, twoFactor]),
	);
}

async function endAllAnnouncements() {
	await withSeedPool((pool) =>
		pool.query(`update announcement set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour'`),
	);
}

test("a user who is not an admin sees 'not found', and every console procedure answers 404", async ({
	authPage: page,
	baseURL,
}) => {
	await page.goto("/admin");
	await expect(page.getByTestId("admin-not-found")).toBeVisible();
	await expect(page.getByTestId("admin-console")).toHaveCount(0);

	const response = await page.request.post("/api/rpc/admin/orgs/list", {
		data: { json: {} },
		headers: { origin: String(baseURL) },
	});
	expect(response.status()).toBe(404);
});

test("an admin without two-factor authentication is told to turn it on, and the server answers 403", async ({
	authPage: page,
	account,
	baseURL,
}) => {
	await setRole(account.email, "admin", false);
	try {
		await page.goto("/admin");
		await expect(page.getByTestId("admin-two-factor-required")).toBeVisible();
		await expect(page.getByTestId("admin-console")).toHaveCount(0);

		const response = await page.request.post("/api/rpc/admin/orgs/list", {
			data: { json: {} },
			headers: { origin: String(baseURL) },
		});
		expect(response.status()).toBe(403);
		const body = (await response.json()) as Rpc;
		expect(body.json?.data?.code).toBe("TWO_FACTOR_REQUIRED");
	} finally {
		await setRole(account.email, "user", false);
	}
});

test("an admin with two-factor authentication lists organizations, suspends one with a reason, and it is audited", async ({
	authPage: page,
	account,
}) => {
	const organizationId = await accountOrganizationId(account);
	await setRole(account.email, "admin", true);
	try {
		await page.goto("/admin/organizations");
		await expect(page.getByTestId("admin-console")).toBeVisible();
		await expect(page.getByTestId("admin-orgs-table")).toBeVisible();

		await page.goto(`/admin/organizations/${organizationId}`);
		await expect(page.getByTestId("admin-org-overview")).toBeVisible();

		// A reason of at least 10 characters is required before the button works.
		const reason = page.getByLabel("Reason (recorded in the audit log)").first();
		const suspend = page.getByRole("button", { name: "Suspend organization" });
		await expect(suspend).toBeDisabled();
		await reason.fill("e2e: unpaid invoice 42");
		await suspend.click();
		await expect(page.getByText("Organization suspended.")).toBeVisible();
		await expect(page.getByRole("button", { name: "Reactivate organization" })).toBeVisible();

		const rows = await withSeedPool((pool) =>
			pool.query<{ action: string; organization_id: string | null; metadata: { reason?: string } }>(
				`select action, organization_id, metadata from audit_log
				 where action in ('admin.org_status_set', 'org.status_changed') and (target_id = $1 or organization_id = $1)
				 order by created_at`,
				[organizationId],
			),
		);
		expect(rows.rows.map((row) => row.action)).toEqual(expect.arrayContaining(["admin.org_status_set"]));
		expect(JSON.stringify(rows.rows)).toContain("e2e: unpaid invoice 42");

		// The audit page shows it.
		await page.goto("/admin/audit");
		await expect(page.getByTestId("admin-audit-table").getByText("admin.org_status_set").first()).toBeVisible();
	} finally {
		await withSeedPool((pool) =>
			pool.query("select careeros_set_org_plan($1, null, 'active', null, 'e2e cleanup')", [organizationId]),
		);
		await setRole(account.email, "user", false);
	}
});

test("an announcement shows to a member on the dashboard and is dismissed for that member only", async ({
	authPage: page,
	account,
}) => {
	await setRole(account.email, "admin", true);
	const title = `Maintenance tonight ${account.username}`;
	try {
		await page.goto("/admin/announcements");
		await page.getByLabel("Title").fill(title);
		await page.getByLabel("Message (plain text, up to 1,000 characters)").fill("<b>Short</b> downtime at 22:00 UTC.");
		await page.getByRole("button", { name: "Publish announcement" }).click();
		await expect(page.getByText("Announcement saved.")).toBeVisible();

		await page.goto("/dashboard");
		const banner = page.getByTestId("announcement-banner");
		await expect(banner).toContainText(title);
		// Plain text: the markup is shown as typed, not rendered.
		await expect(banner).toContainText("<b>Short</b> downtime");

		await page.getByRole("button", { name: "Dismiss announcement" }).first().click();
		await expect(page.getByTestId("announcement-banner")).toHaveCount(0);
		await page.reload();
		await expect(page.getByTestId("announcement-banner")).toHaveCount(0);
	} finally {
		await endAllAnnouncements();
		await setRole(account.email, "user", false);
	}
});

test("the console and its procedures do not exist on an organization host", async ({
	authPage: page,
	account,
	playwright,
	baseURL,
}) => {
	test.skip(!orgHostsConfigured(), "needs the e2e server to run with ORG_HOST_PATTERN={slug}.orgs.test");
	const organizationId = await accountOrganizationId(account);
	const slug = await withSeedPool(async (pool) => {
		const result = await pool.query<{ slug: string }>("select slug from organization where id = $1", [organizationId]);
		return result.rows[0]?.slug ?? "";
	});
	const port = new URL(String(baseURL)).port;
	const host = `${slug}.orgs.test${port ? `:${port}` : ""}`;
	await setRole(account.email, "admin", true);
	try {
		const cookies = (await page.context().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
		const rpc = await send(playwright, String(baseURL), {
			method: "POST",
			path: "/api/rpc/admin/orgs/list",
			host,
			origin: `http://${host}`,
			cookie: cookies,
			data: { json: {} },
		});
		expect(rpc.response.status()).toBe(404);
		const shell = await send(playwright, String(baseURL), { method: "GET", path: "/admin/organizations", host });
		expect(shell.response.status()).toBe(404);
	} finally {
		await setRole(account.email, "user", false);
	}
});
