import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	EXPECTED_REFUSAL,
	rpcPath,
	SUPER_ADMIN_PROCEDURES,
	type SuperAdminSeed,
} from "@careeros/testing/super-admin-inventory";
import { accountOrganizationId, deleteE2EOrganizations } from "../fixtures/careeros-org";
import { deleteE2EUser } from "../fixtures/db";
import { makeOrgHost, ORG_HOST_LAUNCH_OPTIONS, orgHostsConfigured, send } from "../fixtures/org-hosts";
import { withSeedPool } from "../fixtures/seed-db";
import { expect, test } from "../fixtures/test";

// P3-Q03: the Super Admin console cannot be reached or abused by anyone but platform staff, in a real browser and over
// real HTTP. The procedure and page lists come from the source (the shared inventory, which apps/server's unit test keeps
// equal to the router, and the files of apps/web/src/routes/admin), so a new procedure or page is covered automatically.
// The admin role and the two-factor flag are set in the database, as tooling/careeros/platform-admin.mjs does in
// production. Serial: the impersonation tests share the platform's one set of support sessions.
test.describe.configure({ mode: "serial" });
test.use({ launchOptions: ORG_HOST_LAUNCH_OPTIONS });

const REASON = "e2e: security test support ticket";

async function setRole(email: string, role: string, twoFactor: boolean) {
	await withSeedPool((pool) =>
		pool.query(`update "user" set role = $2, two_factor_enabled = $3 where email = $1`, [email, role, twoFactor]),
	);
}

/**
 * A request from inside the member's page, to the host the page is on. Only the browser resolves `*.orgs.test` (through
 * ORG_HOST_LAUNCH_OPTIONS); Playwright's APIRequestContext does not, so `page.request` cannot reach an organization host.
 */
async function statusFromPage(page: Page, path: string, init?: { method: "GET" | "POST"; body?: unknown }) {
	return await page.evaluate(
		async ({ path: target, init: options }) => {
			const response = await fetch(target, {
				method: options?.method ?? "GET",
				credentials: "include",
				redirect: "manual",
				...(options?.method === "POST"
					? { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body ?? {}) }
					: {}),
			});
			return response.status;
		},
		{ path, init },
	);
}

async function adminAuditCount() {
	return await withSeedPool(async (pool) => {
		const { rows } = await pool.query<{ n: string }>(
			"select count(*)::text as n from audit_log where action like 'admin.%'",
		);
		return rows[0]?.n;
	});
}

/** The URL of every page of the console, from the route files (index.tsx is /admin, `$param` takes an id). */
function consolePages(organizationId: string): string[] {
	const files = readdirSync(join(process.cwd(), "apps/web/src/routes/admin")).filter(
		(name) => name.endsWith(".tsx") && name !== "route.tsx",
	);
	const pages = files.map((name) => {
		const segments = name
			.replace(/\.tsx$/, "")
			.split(".")
			.filter((segment) => segment !== "index")
			.map((segment) => (segment.startsWith("$") ? organizationId : segment));
		return `/admin${segments.length > 0 ? `/${segments.join("/")}` : ""}`;
	});
	return [...new Set(pages)].sort();
}

test("the console's pages and procedures refuse a user who is not an admin, and an admin without 2FA", async ({
	authPage: page,
	account,
	playwright,
	baseURL,
}) => {
	const root = String(baseURL);
	const organizationId = await accountOrganizationId(account);
	const userId = await withSeedPool(async (pool) => {
		const { rows } = await pool.query<{ id: string }>('select id from "user" where email = $1', [account.email]);
		return rows[0]?.id ?? "";
	});
	const seed: SuperAdminSeed = {
		orgId: organizationId,
		userId,
		announcementId: "none",
		planId: "starter",
		unique: randomUUID(),
	};
	const pages = consolePages(organizationId);
	expect(pages, "the page list is read from the route files").toEqual(
		expect.arrayContaining([
			"/admin",
			"/admin/audit",
			"/admin/metrics",
			"/admin/announcements",
			"/admin/organizations",
		]),
	);
	const anonymous = await playwright.request.newContext({ baseURL: root });
	const rpc = (request: typeof page.request, path: string, input: unknown) =>
		request.post(rpcPath(path), {
			headers: { "content-type": "application/json", origin: root },
			data: { json: input },
			failOnStatusCode: false,
		});
	try {
		const before = await adminAuditCount();
		// An ordinary member, then an admin who has not turned on two-factor authentication.
		for (const [who, request, expected] of [
			["a member", page.request, EXPECTED_REFUSAL.member],
			["an anonymous caller", anonymous, EXPECTED_REFUSAL.anonymous],
		] as const)
			for (const procedure of SUPER_ADMIN_PROCEDURES) {
				const response = await rpc(request, procedure.path, procedure.input(seed));
				expect(response.status(), `${who} calling ${procedure.path}`).toBe(expected.status);
			}
		await setRole(account.email, "admin", false);
		for (const procedure of SUPER_ADMIN_PROCEDURES) {
			const response = await rpc(page.request, procedure.path, procedure.input(seed));
			expect(response.status(), `an admin without 2FA calling ${procedure.path}`).toBe(
				EXPECTED_REFUSAL["platform admin without 2FA"].status,
			);
			expect(((await response.json()) as { json?: { data?: { code?: string } } }).json?.data?.code).toBe(
				"TWO_FACTOR_REQUIRED",
			);
		}
		expect(await adminAuditCount(), "no refused call wrote an admin audit row").toBe(before);

		// The pages: a member sees "not found", an admin without 2FA is sent to turn it on, and neither sees the console.
		await setRole(account.email, "user", false);
		for (const path of pages) {
			await page.goto(path);
			await expect(page.getByTestId("admin-not-found"), path).toBeVisible();
			await expect(page.getByTestId("admin-console"), path).toHaveCount(0);
		}
		await setRole(account.email, "admin", false);
		for (const path of pages) {
			await page.goto(path);
			await expect(page.getByTestId("admin-two-factor-required"), path).toBeVisible();
			await expect(page.getByTestId("admin-console"), path).toHaveCount(0);
		}

		// Control: the same pages are the console for an admin with two-factor authentication.
		await setRole(account.email, "admin", true);
		await page.goto("/admin/organizations");
		await expect(page.getByTestId("admin-console")).toBeVisible();
	} finally {
		await anonymous.dispose();
		await setRole(account.email, "user", false);
	}
});

test("the console's pages and procedures do not exist on an organization host or a custom domain, even for an admin with 2FA", async ({
	authPage: page,
	account,
	playwright,
	baseURL,
}) => {
	test.skip(!orgHostsConfigured(), "needs the e2e server to run with ORG_HOST_PATTERN={slug}.orgs.test");
	const organizationId = await accountOrganizationId(account);
	const slug = await withSeedPool(async (pool) => {
		const { rows } = await pool.query<{ slug: string }>("select slug from organization where id = $1", [
			organizationId,
		]);
		return rows[0]?.slug ?? "";
	});
	const userId = await withSeedPool(async (pool) => {
		const { rows } = await pool.query<{ id: string }>('select id from "user" where email = $1', [account.email]);
		return rows[0]?.id ?? "";
	});
	const port = new URL(String(baseURL)).port;
	const suffix = port ? `:${port}` : "";
	const customHost = `jobs-${slug}.example.test${suffix}`;
	// A custom domain resolves to an organization only when the server has Cloudflare custom hostnames configured
	// (CF_SAAS_*); without them the host is unknown and the request is turned away earlier as a cross-site call (403,
	// the same for every procedure, not specific to the console). The custom domain case is covered over HTTP in
	// apps/server/src/http/super-admin-security.integration.test.ts, which enables custom domains.
	const customDomainsOn = Boolean(
		process.env.CF_SAAS_API_TOKEN && process.env.CF_ZONE_ID && process.env.CF_SAAS_CNAME_TARGET,
	);
	const hosts = customDomainsOn ? [`${slug}.orgs.test${suffix}`, customHost] : [`${slug}.orgs.test${suffix}`];
	await withSeedPool((pool) =>
		pool.query(
			"insert into organization_domain (id, organization_id, hostname, status, verification_token) values ($1, $2, $3, 'active', 'token')",
			[`dom-${randomUUID()}`, organizationId, `jobs-${slug}.example.test`],
		),
	);
	await setRole(account.email, "admin", true);
	const seed: SuperAdminSeed = {
		orgId: organizationId,
		userId,
		announcementId: "none",
		planId: "starter",
		unique: randomUUID(),
	};
	try {
		const cookies = (await page.context().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
		const before = await adminAuditCount();
		for (const host of hosts) {
			for (const procedure of SUPER_ADMIN_PROCEDURES) {
				const reply = await send(playwright, String(baseURL), {
					method: "POST",
					path: rpcPath(procedure.path),
					host,
					origin: `http://${host}`,
					cookie: cookies,
					data: { json: procedure.input(seed) },
				});
				expect(reply.response.status(), `${procedure.path} on ${host}`).toBe(404);
			}
			for (const path of consolePages(organizationId)) {
				const reply = await send(playwright, String(baseURL), { method: "GET", path, host });
				expect(reply.response.status(), `${path} on ${host}`).toBe(404);
				expect(reply.body, `${path} on ${host} is not the app shell`).not.toContain('id="app"');
			}
		}
		expect(await adminAuditCount(), "nothing was audited: nothing ran").toBe(before);
		// Control: on the platform host, with the same session, the console answers.
		const platform = await page.request.post(rpcPath("admin.orgs.list"), {
			headers: { "content-type": "application/json", origin: String(baseURL) },
			data: { json: {} },
		});
		expect(platform.status()).toBe(200);
	} finally {
		await withSeedPool((pool) =>
			pool.query("delete from organization_domain where organization_id = $1", [organizationId]),
		);
		await setRole(account.email, "user", false);
	}
});

test.describe("support sessions in a browser", () => {
	test.skip(!orgHostsConfigured(), "needs the e2e server to run with ORG_HOST_PATTERN={slug}.orgs.test");

	test("a banner shows on every page for the whole session and cannot be dismissed; End now ends it, audited in both places", async ({
		authPage: page,
		account,
		playwright,
		browser,
		baseURL,
	}, testInfo) => {
		test.setTimeout(120_000);
		const root = String(baseURL ?? testInfo.project.use.baseURL ?? "http://localhost:3000");
		const port = new URL(root).port || "80";
		const tag = randomUUID().slice(0, 8);
		const org = makeOrgHost("sq3", "a", tag, port);
		const target = {
			name: "Support Target",
			username: `sq3_t_${tag}`,
			email: `sq3_t_${tag}@example.test`,
			password: account.password,
		};
		const platform = await playwright.request.newContext({ baseURL: root, extraHTTPHeaders: { origin: root } });
		try {
			const created = await platform.post("/api/auth/sign-up/email", {
				data: {
					name: target.name,
					email: target.email,
					password: target.password,
					username: target.username,
					displayUsername: target.username,
				},
			});
			expect(created.ok()).toBe(true);
			const targetId = await withSeedPool(async (pool) => {
				await pool.query("insert into organization (id, name, slug) values ($1, $2, $3)", [
					org.id,
					`Org ${tag}`,
					org.slug,
				]);
				const { rows } = await pool.query<{ id: string }>('select id from "user" where email = $1', [target.email]);
				const id = rows[0]?.id ?? "";
				await pool.query("insert into member (id, organization_id, user_id, role) values ($1, $2, $3, 'owner')", [
					`m-${tag}`,
					org.id,
					id,
				]);
				return id;
			});
			await setRole(account.email, "admin", true);

			const start = await page.request.post(rpcPath("admin.impersonation.start"), {
				headers: { "content-type": "application/json", origin: root },
				data: { json: { organizationId: org.id, userId: targetId, reason: REASON } },
			});
			expect(start.status(), await start.text()).toBe(200);
			const { url } = ((await start.json()) as { json: { url: string } }).json;
			const impersonationId = new URLSearchParams(new URL(url).hash.slice(1)).get("id") ?? "";

			// The member's browser: a fresh context that follows the link to the member's own organization host.
			const context = await browser.newContext();
			const member = await context.newPage();
			try {
				await member.goto(url);
				await member.waitForURL(/\/dashboard/, { timeout: 30_000 });
				// The link's token is gone from the address bar and the history.
				expect(member.url()).not.toContain("token=");

				// A banner on every page, whatever the page, for as long as the session lasts.
				const pages = [
					"/dashboard",
					"/dashboard/resumes",
					"/dashboard/applications",
					"/dashboard/settings/profile",
					"/dashboard/settings/account",
				];
				for (const path of pages) {
					await member.goto(`${org.origin}${path}`);
					const banner = member.getByTestId("impersonation-banner");
					await expect(banner, `the banner on ${path}`).toBeVisible();
					await expect(banner).toContainText("A platform administrator is signed in as you");
				}
				// It cannot be dismissed: End now is its only control, and a reload brings it back.
				const banner = member.getByTestId("impersonation-banner");
				await expect(banner.getByRole("button")).toHaveCount(1);
				await expect(banner.getByRole("button", { name: "End now" })).toBeVisible();
				await member.reload();
				await expect(member.getByTestId("impersonation-banner")).toBeVisible();

				// The console does not exist on the member's host, and the admin API is refused in the support session.
				expect(await statusFromPage(member, "/admin/organizations")).toBe(404);
				expect(await statusFromPage(member, rpcPath("admin.orgs.list"), { method: "POST", body: { json: {} } })).toBe(
					404,
				);

				// End now ends it for good.
				await banner.getByRole("button", { name: "End now" }).click();
				await expect(member.getByTestId("impersonation-banner")).toHaveCount(0, { timeout: 30_000 });
				await member.goto(`${org.origin}/dashboard`);
				await expect(member).toHaveURL(/\/auth\/login/);
			} finally {
				await context.close();
			}

			const rows = await withSeedPool(async (pool) => {
				const result = await pool.query<{ action: string; organization_id: string | null }>(
					"select action, organization_id from audit_log where metadata ->> 'impersonationId' = $1 order by action",
					[impersonationId],
				);
				return result.rows.map((row) => [row.action, row.organization_id]);
			});
			expect(rows).toEqual([
				["admin.impersonation_ended", null],
				["admin.impersonation_started", null],
				["impersonation.ended", org.id],
				["impersonation.started", org.id],
			]);
		} finally {
			await platform.dispose();
			await setRole(account.email, "user", false);
			await deleteE2EOrganizations([target]);
			await deleteE2EUser(target);
		}
	});

	test("after its time limit the next request is refused and the banner is gone", async ({
		authPage: page,
		account,
		playwright,
		browser,
		baseURL,
	}, testInfo) => {
		test.setTimeout(120_000);
		const root = String(baseURL ?? testInfo.project.use.baseURL ?? "http://localhost:3000");
		const port = new URL(root).port || "80";
		const tag = randomUUID().slice(0, 8);
		const org = makeOrgHost("sq3", "e", tag, port);
		const target = {
			name: "Expiry Target",
			username: `sq3_e_${tag}`,
			email: `sq3_e_${tag}@example.test`,
			password: account.password,
		};
		const platform = await playwright.request.newContext({ baseURL: root, extraHTTPHeaders: { origin: root } });
		try {
			const created = await platform.post("/api/auth/sign-up/email", {
				data: {
					name: target.name,
					email: target.email,
					password: target.password,
					username: target.username,
					displayUsername: target.username,
				},
			});
			expect(created.ok()).toBe(true);
			const targetId = await withSeedPool(async (pool) => {
				await pool.query("insert into organization (id, name, slug) values ($1, $2, $3)", [
					org.id,
					`Org ${tag}`,
					org.slug,
				]);
				const { rows } = await pool.query<{ id: string }>('select id from "user" where email = $1', [target.email]);
				const id = rows[0]?.id ?? "";
				await pool.query("insert into member (id, organization_id, user_id, role) values ($1, $2, $3, 'owner')", [
					`m-${tag}`,
					org.id,
					id,
				]);
				return id;
			});
			await setRole(account.email, "admin", true);
			const start = await page.request.post(rpcPath("admin.impersonation.start"), {
				headers: { "content-type": "application/json", origin: root },
				data: { json: { organizationId: org.id, userId: targetId, reason: REASON } },
			});
			expect(start.status(), await start.text()).toBe(200);
			const { url } = ((await start.json()) as { json: { url: string } }).json;
			const impersonationId = new URLSearchParams(new URL(url).hash.slice(1)).get("id") ?? "";

			const context = await browser.newContext();
			const member = await context.newPage();
			try {
				await member.goto(url);
				await member.waitForURL(/\/dashboard/, { timeout: 30_000 });
				await expect(member.getByTestId("impersonation-banner")).toBeVisible();

				// The 60 minutes run out (the record's clock is the database's, so move the record back).
				await withSeedPool((pool) =>
					pool.query("update impersonation set expires_at = now() - interval '1 second' where id = $1", [
						impersonationId,
					]),
				);
				await member.goto(`${org.origin}/dashboard`);
				await expect(member).toHaveURL(/\/auth\/login/);
				await expect(member.getByTestId("impersonation-banner")).toHaveCount(0);
				expect(
					await statusFromPage(member, rpcPath("impersonation.current"), { method: "POST", body: { json: {} } }),
				).toBe(401);
			} finally {
				await context.close();
			}

			// The sweep audits the expiry in the member's organization and in the platform log.
			const ended = await withSeedPool(async (pool) => {
				await pool.query("select careeros_impersonation_expire_due()");
				const result = await pool.query<{ action: string; organization_id: string | null; reason: string }>(
					"select action, organization_id, metadata ->> 'endReason' as reason from audit_log where metadata ->> 'impersonationId' = $1 and action like '%ended' order by action",
					[impersonationId],
				);
				return result.rows.map((row) => [row.action, row.organization_id, row.reason]);
			});
			expect(ended).toEqual([
				["admin.impersonation_ended", null, "expired"],
				["impersonation.ended", org.id, "expired"],
			]);
		} finally {
			await platform.dispose();
			await setRole(account.email, "user", false);
			await deleteE2EOrganizations([target]);
			await deleteE2EUser(target);
		}
	});
});
