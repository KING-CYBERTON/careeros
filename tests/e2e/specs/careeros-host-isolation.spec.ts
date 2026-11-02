import { randomUUID } from "node:crypto";
import {
	cookiePairs,
	createHostOrgs,
	type HostOrgs,
	ORG_HOST_LAUNCH_OPTIONS,
	ORG_HOST_PATTERN,
	orgHostsConfigured,
	send,
} from "../fixtures/org-hosts";
import { withSeedPool } from "../fixtures/seed-db";
import { expect, test } from "../fixtures/test";

// P2-Q01: a session from Organization A's host cannot act in Organization B on B's host. The server runs with
// ORG_HOST_PATTERN={slug}.orgs.test (the CI e2e job sets it; no other e2e host matches it). API checks reach an
// organization host with a Host header; the browser checks use a Chromium host-resolver rule. Both organizations get an
// owner and a member, each with a real session created on their own host.
test.skip(
	!orgHostsConfigured(),
	`needs the e2e server to run with ORG_HOST_PATTERN=${ORG_HOST_PATTERN} (the CI e2e job sets it)`,
);
test.use({ launchOptions: ORG_HOST_LAUNCH_OPTIONS });

const NOT_MEMBER = { code: "FORBIDDEN", data: { code: "ORG_HOST_NOT_MEMBER" } };
const KEY_MISMATCH = { code: "FORBIDDEN", data: { code: "ORG_HOST_KEY_MISMATCH" } };

type Json = Record<string, unknown>;
const parse = (body: string): Json => {
	try {
		return JSON.parse(body) as Json;
	} catch {
		return {};
	}
};

test.describe("host isolation", () => {
	test.describe.configure({ mode: "serial" });

	let orgs: HostOrgs;
	let baseURL: string;
	let tag: string;
	let resumeA: { id: string; name: string; username: string; slug: string };
	let resumeB: { id: string; name: string };
	let keyA: string;
	// Text that appears only in Organization B's rows, to prove none of it reaches Organization A's session.
	let markerA: string;
	let markerB: string;

	test.beforeAll(async ({ playwright }, testInfo) => {
		test.setTimeout(120_000);
		baseURL = String(testInfo.project.use.baseURL ?? "http://localhost:3000");
		orgs = await createHostOrgs(playwright, baseURL, { prefix: "iso" });
		tag = orgs.a.slug.slice(-8);
		markerA = `IsoMarkA${tag}`;
		markerB = `IsoMarkB${tag}`;
		const { a, b } = orgs;

		const createResume = async (org: typeof a, marker: string) => {
			const name = `${marker} resume`;
			const slug = `${marker.toLowerCase()}-resume`;
			const created = await send(playwright, baseURL, {
				method: "POST",
				path: "/api/openapi/resumes",
				host: org.host,
				origin: org.origin,
				cookie: org.member.cookie,
				data: { name, slug, tags: [marker] },
			});
			expect(created.response.status(), created.body).toBe(200);
			const id = JSON.parse(created.body) as string;
			return { id, name, username: org.member.account.username, slug };
		};
		resumeA = await createResume(a, markerA);
		resumeB = await createResume(b, markerB);

		// An API key made on A's host belongs to Organization A.
		const key = await send(playwright, baseURL, {
			method: "POST",
			path: "/api/openapi/auth/api-keys",
			host: a.host,
			origin: a.origin,
			cookie: a.member.cookie,
			data: { name: `iso-${tag}`, expiresIn: null, access: "full" },
		});
		expect(key.response.status(), key.body).toBe(200);
		keyA = (JSON.parse(key.body) as { key: string }).key;

		await withSeedPool(async (pool) => {
			// A custom domain that is still pending verification (the P2-T06 row, seeded: no Cloudflare in the e2e server).
			await pool.query(
				`insert into organization_domain (id, organization_id, hostname, verification_token, created_by)
				 values ($1, $2, $3, $4, $5)`,
				[`iso-dom-${tag}`, a.id, `careers-${tag}.pending.example.test`, `isotoken${tag}`, a.owner.userId],
			);
			await pool.query("update organization_branding set app_name = $2 where organization_id = $1", [
				a.id,
				`IsoAlpha ${tag}`,
			]);
		});
	});

	test.afterAll(async () => {
		await orgs?.dispose();
	});

	const call = (
		playwright: Parameters<typeof send>[0],
		org: { host: string; origin: string },
		cookie: string | undefined,
		options: { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; path: string; data?: unknown; apiKey?: string },
	) =>
		send(playwright, baseURL, {
			method: options.method ?? "GET",
			path: options.path,
			host: org.host,
			origin: org.origin,
			...(cookie ? { cookie } : {}),
			...(options.apiKey ? { apiKey: options.apiKey } : {}),
			...(options.data === undefined ? {} : { data: options.data }),
		});

	test("control: a member acts in their own organization on its host", async ({ playwright }) => {
		const { a, b } = orgs;
		const list = await call(playwright, a, a.member.cookie, { path: "/api/openapi/resumes" });
		expect(list.response.status(), list.body).toBe(200);
		expect(list.body).toContain(markerA);
		expect(list.body).not.toContain(markerB);

		const one = await call(playwright, a, a.member.cookie, { path: `/api/openapi/resumes/${resumeA.id}` });
		expect(one.response.status(), one.body).toBe(200);
		expect(one.body).toContain(markerA);

		// And B's member in B.
		const own = await call(playwright, b, b.member.cookie, { path: "/api/openapi/resumes" });
		expect(own.response.status(), own.body).toBe(200);
		expect(own.body).toContain(markerB);
		expect(own.body).not.toContain(markerA);
	});

	test("A's session on B's host: reads, a resume by A's id and an RPC call all fail, and no data of B appears", async ({
		playwright,
	}) => {
		const { a, b } = orgs;
		const attempts = [
			{ path: "/api/openapi/resumes" },
			{ path: `/api/openapi/resumes/${resumeA.id}` },
			// B's own id: a non-member cannot read it either.
			{ path: `/api/openapi/resumes/${resumeB.id}` },
			{ path: "/api/openapi/branding" },
			{ path: "/api/openapi/applications" },
			{ path: "/api/rpc/resume/list" },
			{ path: "/api/rpc/branding/get" },
		];
		for (const cookie of [a.member.cookie, a.owner.cookie]) {
			for (const attempt of attempts) {
				const { response, body } = await call(playwright, b, cookie, attempt);
				const label = `${attempt.path} -> ${response.status()} ${body.slice(0, 300)}`;
				expect(response.status(), label).toBe(403);
				// The RPC adapter wraps the error in a `json` envelope.
				const error = (parse(body).json ?? parse(body)) as Json;
				expect(error, label).toMatchObject(NOT_MEMBER);
				expect(body, label).not.toContain(markerB);
				expect(body, label).not.toContain(resumeB.id);
				expect(body, label).not.toContain(b.id);
			}
		}

		// The mirror image: B's session on A's host.
		for (const attempt of attempts.slice(0, 2)) {
			const { response, body } = await call(playwright, a, b.member.cookie, attempt);
			expect(response.status(), `${attempt.path} -> ${body.slice(0, 300)}`).toBe(403);
			expect(body).not.toContain(markerA);
		}
	});

	test("A's session cannot change B: an org-scoped mutation and a create are refused and nothing is written", async ({
		playwright,
	}) => {
		const { a, b } = orgs;
		const before = await withSeedPool(async (pool) => {
			const branding = await pool.query(
				"select app_name, updated_at from organization_branding where organization_id = $1",
				[b.id],
			);
			const resumes = await pool.query("select count(*)::int as n from resume where organization_id = $1", [b.id]);
			return { branding: branding.rows[0], resumes: resumes.rows[0].n as number };
		});

		// The owner of A is an owner nowhere in B: the role does not travel with the session.
		const rename = await call(playwright, b, a.owner.cookie, {
			method: "PATCH",
			path: "/api/openapi/branding",
			data: { appName: `Hijacked ${tag}` },
		});
		expect(rename.response.status(), rename.body).toBe(403);
		expect(parse(rename.body)).toMatchObject(NOT_MEMBER);

		const create = await call(playwright, b, a.member.cookie, {
			method: "POST",
			path: "/api/openapi/resumes",
			data: { name: `Planted ${tag}`, slug: `planted-${tag}`, tags: [] },
		});
		expect(create.response.status(), create.body).toBe(403);
		expect(parse(create.body)).toMatchObject(NOT_MEMBER);

		const del = await call(playwright, b, a.member.cookie, {
			method: "DELETE",
			path: `/api/openapi/resumes/${resumeB.id}`,
		});
		expect(del.response.status(), del.body).toBe(403);

		const after = await withSeedPool(async (pool) => {
			const branding = await pool.query(
				"select app_name, updated_at from organization_branding where organization_id = $1",
				[b.id],
			);
			const resumes = await pool.query("select count(*)::int as n from resume where organization_id = $1", [b.id]);
			const stray = await pool.query("select count(*)::int as n from resume where name like $1", [`Planted ${tag}`]);
			return { branding: branding.rows[0], resumes: resumes.rows[0].n as number, stray: stray.rows[0].n as number };
		});
		expect(after.branding).toEqual(before.branding);
		expect(after.resumes).toBe(before.resumes);
		expect(after.stray).toBe(0);
	});

	test("an API key bound to Organization A is refused on B's host and works on A's", async ({ playwright }) => {
		const { a, b } = orgs;
		const onA = await call(playwright, a, undefined, { path: "/api/openapi/resumes", apiKey: keyA });
		expect(onA.response.status(), onA.body).toBe(200);
		expect(onA.body).toContain(markerA);

		for (const path of ["/api/openapi/resumes", `/api/openapi/resumes/${resumeB.id}`, "/api/openapi/branding"]) {
			const onB = await call(playwright, b, undefined, { path, apiKey: keyA });
			expect(onB.response.status(), `${path} ${onB.body}`).toBe(403);
			expect(parse(onB.body)).toMatchObject(KEY_MISMATCH);
			expect(onB.body).not.toContain(markerB);
		}
		const mutation = await call(playwright, b, undefined, {
			method: "POST",
			path: "/api/openapi/resumes",
			apiKey: keyA,
			data: { name: `Keyed ${tag}`, slug: `keyed-${tag}`, tags: [] },
		});
		expect(mutation.response.status(), mutation.body).toBe(403);
		const rpc = await call(playwright, b, undefined, { path: "/api/rpc/resume/list", apiKey: keyA });
		expect(rpc.response.status(), rpc.body).toBe(403);
	});

	test("an unknown organization-shaped host answers the not-set-up page with 404 and noindex", async ({
		playwright,
		browser,
	}) => {
		const port = new URL(baseURL).port || "80";
		const host = `nope${randomUUID().slice(0, 8)}.orgs.test:${port}`;
		const page = await send(playwright, baseURL, { method: "GET", path: "/", host });
		expect(page.response.status()).toBe(404);
		expect(page.response.headers()["x-robots-tag"]).toMatch(/noindex/);
		expect(page.body).toContain("__ORG_NOT_FOUND__");

		const api = await send(playwright, baseURL, { method: "GET", path: "/api/openapi/resumes", host });
		expect(api.response.status()).toBe(404);
		// Even with a real session: the host names no organization, so nothing falls back to the platform's rules.
		const withSession = await send(playwright, baseURL, {
			method: "GET",
			path: "/api/openapi/resumes",
			host,
			cookie: orgs.a.member.cookie,
		});
		expect(withSession.response.status()).toBe(404);
		expect(withSession.body).not.toContain(markerA);

		// The browser gets the 404 shell with the flag that makes the app show the neutral page. Drawing that page is not
		// asserted: the host middleware also answers this shell for /assets/*.js, so the script never loads (docs/questions.md Q152).
		const context = await browser.newContext();
		try {
			const view = await context.newPage();
			const response = await view.goto(`http://${host}/`, { waitUntil: "domcontentloaded" });
			expect(response?.status()).toBe(404);
			expect(await view.evaluate(() => (globalThis as { __ORG_NOT_FOUND__?: unknown }).__ORG_NOT_FOUND__)).toBe(true);
			expect(await view.locator("body").innerText()).not.toContain(markerA);
		} finally {
			await context.close();
		}
	});

	test("a custom domain still pending does not resolve as Organization A and fails closed", async ({ playwright }) => {
		const { a } = orgs;
		const host = `careers-${tag}.pending.example.test`;
		const cloudflareConfigured = Boolean(
			process.env.CF_SAAS_API_TOKEN && process.env.CF_ZONE_ID && process.env.CF_SAAS_CNAME_TARGET,
		);

		const page = await send(playwright, baseURL, { method: "GET", path: "/", host });
		// Never Organization A's branded shell, whatever else the host answers.
		expect(page.body).not.toContain(`IsoAlpha ${tag}`);
		expect(page.body).not.toContain(a.id);
		const anonymous = await send(playwright, baseURL, { method: "GET", path: "/api/openapi/resumes", host });
		expect(anonymous.response.status()).toBe(cloudflareConfigured ? 404 : 401);
		expect(anonymous.body).not.toContain(markerA);

		if (cloudflareConfigured) {
			// Custom domains are on: a pending host answers like an unknown organization address.
			expect(page.response.status()).toBe(404);
			expect(page.response.headers()["x-robots-tag"]).toMatch(/noindex/);
			const withSession = await send(playwright, baseURL, {
				method: "GET",
				path: "/api/openapi/resumes",
				host,
				cookie: a.member.cookie,
			});
			expect(withSession.response.status()).toBe(404);
		}
		// Without the Cloudflare settings (the CI e2e server) custom domains are off and the host is simply unknown to the
		// platform. The hard 404 for a pending row is covered by tenancy's host.integration.test.ts (docs/questions.md Q151).
	});

	test("A's cookie planted for B's host shows the organization-access page in the browser, never B's data", async ({
		browser,
	}) => {
		test.setTimeout(90_000);
		const { a, b } = orgs;
		const sessionCookie = (header: string) => {
			const [name = "", ...rest] = header.split("; ")[0]?.split("=") ?? [];
			return { name, value: rest.join("=") };
		};
		const { name, value } = sessionCookie(a.member.cookie);
		const context = await browser.newContext();
		try {
			// The cookie a browser would only hold for A's host, set for B's host as well.
			await context.addCookies([
				{ name, value, domain: `${b.slug}.orgs.test`, path: "/", httpOnly: true, sameSite: "Lax" },
				{ name, value, domain: `${a.slug}.orgs.test`, path: "/", httpOnly: true, sameSite: "Lax" },
			]);
			const view = await context.newPage();

			// Control: on A's host the same cookie reaches A's own resume list.
			await view.goto(`${a.origin}/dashboard/resumes`);
			await expect(view.getByText(resumeA.name).first()).toBeVisible({ timeout: 30_000 });

			await view.goto(`${b.origin}/dashboard/resumes`);
			await expect(view).toHaveURL(new RegExp(`${b.slug}\\.orgs\\.test.*/auth/organization-access`), {
				timeout: 30_000,
			});
			await expect(view.getByRole("heading", { name: /not a member of/i })).toBeVisible({ timeout: 20_000 });
			const text = await view.locator("body").innerText();
			expect(text).not.toContain(markerB);
			expect(text).not.toContain(resumeB.name);
			expect(await view.content()).not.toContain(markerB);
			// B is invite only, so there is no way to join from here.
			await expect(view.getByRole("button", { name: /join this organization/i })).toHaveCount(0);
		} finally {
			await context.close();
		}
	});

	test("the session cookie of a sign-in on A's host is host-only", async ({ playwright }) => {
		const { a } = orgs;
		const { response } = await send(playwright, baseURL, {
			method: "POST",
			path: "/api/auth/sign-in/email",
			host: a.host,
			origin: a.origin,
			data: { email: a.member.account.email, password: a.member.account.password },
		});
		const lines = cookiePairs(response).join("\n");
		expect(lines).toMatch(/session_token=[^;]+/);
		expect(lines).not.toMatch(/Domain=/i);
	});
});
