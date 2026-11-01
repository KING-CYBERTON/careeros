import type { APIResponse, PlaywrightWorkerArgs } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { withSeedPool } from "../fixtures/seed-db";
import { expect, test } from "../fixtures/test";

// P2-T05: social and OIDC sign-in on an organization host, through the one-time handoff. The e2e environment has no
// stub OIDC provider, so the provider's round trip is replaced by a seeded platform session: the real `begin`, `issue`
// and `redeem` endpoints run, and the issue step sees a platform session that sign-up created, exactly as it would after
// a provider callback. The server needs ORG_HOST_PATTERN={slug}.orgs.test (the CI e2e job sets it; no test host on
// localhost matches it, so every other spec is unaffected). Organization hosts are reached with a Host header for the
// API checks and with a Chromium host-resolver rule for the browser check.
const PATTERN = "{slug}.orgs.test";
test.skip(
	process.env.ORG_HOST_PATTERN !== PATTERN || !process.env.GOOGLE_CLIENT_ID,
	`needs the server to run with ORG_HOST_PATTERN=${PATTERN} and a Google client id (any placeholder)`,
);
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP *.orgs.test 127.0.0.1"] } });

type Playwright = PlaywrightWorkerArgs["playwright"];

type Org = { id: string; slug: string; host: string; origin: string };

const cookiePairs = (response: APIResponse) =>
	response
		.headersArray()
		.filter((header) => header.name.toLowerCase() === "set-cookie")
		.map((header) => header.value);

const cookieHeader = (lines: string[]) =>
	lines
		.map((line) => line.split(";", 1)[0] ?? "")
		.filter((pair) => !pair.endsWith("="))
		.join("; ");

/** One request to an organization host (or the platform), with exactly the cookies and headers given. */
async function send(
	playwright: Playwright,
	baseURL: string,
	options: {
		method: "GET" | "POST";
		path: string;
		host?: string;
		origin?: string;
		cookie?: string;
		data?: unknown;
	},
) {
	const context = await playwright.request.newContext({
		baseURL,
		extraHTTPHeaders: {
			...(options.host ? { host: options.host } : {}),
			...(options.origin ? { origin: options.origin } : {}),
			...(options.cookie ? { cookie: options.cookie } : {}),
		},
	});
	try {
		const response =
			options.method === "GET"
				? await context.get(options.path, { maxRedirects: 0, failOnStatusCode: false })
				: await context.post(options.path, { data: options.data ?? {}, maxRedirects: 0, failOnStatusCode: false });
		return { response, body: await response.text() };
	} finally {
		await context.dispose();
	}
}

test("an organization host signs a member in through begin, issue and redeem, once, on its own host", async ({
	account,
	playwright,
	browser,
}, testInfo) => {
	test.setTimeout(90_000);
	const baseURL = String(testInfo.project.use.baseURL ?? "http://localhost:3000");
	const port = new URL(baseURL).port || "80";
	const tag = randomUUID().slice(0, 8);
	const makeOrg = (label: string): Org => {
		const slug = `h5${label}${tag}`;
		return {
			id: `h5-${label}-${tag}`,
			slug,
			host: `${slug}.orgs.test:${port}`,
			origin: `http://${slug}.orgs.test:${port}`,
		};
	};
	const orgA = makeOrg("a");
	const orgB = makeOrg("b");

	try {
		await withSeedPool(async (pool) => {
			for (const org of [orgA, orgB])
				await pool.query("insert into organization (id, name, slug) values ($1, $2, $3)", [org.id, org.slug, org.slug]);
		});

		// A platform account, a member of Organization A only (Organization B is invite only).
		const platform = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
		const signUp = await platform.post("/api/auth/sign-up/email", {
			data: {
				name: account.name,
				email: account.email,
				password: account.password,
				username: account.username,
				displayUsername: account.username,
			},
		});
		expect(signUp.ok()).toBe(true);
		const platformCookie = cookieHeader(cookiePairs(signUp));
		await platform.dispose();
		const userId = await withSeedPool(async (pool) => {
			const { rows } = await pool.query<{ id: string }>('select id from "user" where email = $1', [account.email]);
			const id = rows[0]?.id ?? "";
			await pool.query("insert into member (id, organization_id, user_id, role) values ($1, $2, $3, 'member')", [
				`m-${tag}`,
				orgA.id,
				id,
			]);
			return id;
		});

		const begin = async (org: Org, extra: { origin?: string } = {}) => {
			const { response, body } = await send(playwright, baseURL, {
				method: "POST",
				path: "/api/careeros/handoff/begin",
				host: org.host,
				origin: extra.origin ?? org.origin,
				data: { provider: "google", returnTo: "/dashboard" },
			});
			return { response, body };
		};
		// Without a configured provider `begin` refuses, so this spec needs the e2e server to have one (the CI job sets a placeholder).
		const started = await begin(orgA);
		expect(started.response.status(), started.body).toBe(200);
		const requestId = new URL((JSON.parse(started.body) as { url: string }).url).searchParams.get("request") ?? "";
		const verifierCookie = cookiePairs(started.response).find((line) => line.startsWith("careeros_handoff="));
		expect(verifierCookie).toMatch(/HttpOnly/);
		expect(verifierCookie).not.toMatch(/Domain=/i);
		const handoffCookie = cookieHeader([verifierCookie ?? ""]);

		// A foreign origin cannot begin, on Organization A's host.
		expect((await begin(orgA, { origin: orgB.origin })).response.status()).toBe(403);

		// Issue, on the platform host, as the member who just signed in there.
		const issued = await send(playwright, baseURL, {
			method: "GET",
			path: `/api/careeros/handoff/issue?request=${requestId}`,
			cookie: platformCookie,
		});
		expect(issued.response.status()).toBe(302);
		const location = new URL(issued.response.headers().location ?? "");
		expect(`${location.origin}${location.pathname}`).toBe(`${orgA.origin}/auth/handoff/redeem`);
		expect(location.search).toBe("");
		const fragment = new URLSearchParams(location.hash.slice(1));
		const token = fragment.get("token") ?? "";
		expect(token.length).toBeGreaterThanOrEqual(43);

		const redeem = (org: Org, cookie: string | undefined) =>
			send(playwright, baseURL, {
				method: "POST",
				path: "/api/careeros/handoff/redeem",
				host: org.host,
				origin: org.origin,
				...(cookie ? { cookie } : {}),
				data: { request: requestId, token },
			});

		// Wrong host, missing cookie and a different browser's cookie all fail, and do not spend the token.
		expect((await redeem(orgB, handoffCookie)).response.status()).toBe(400);
		expect((await redeem(orgA, undefined)).response.status()).toBe(400);
		expect((await redeem(orgA, "careeros_handoff=not-the-browsers-verifier-value-0000000000")).response.status()).toBe(
			400,
		);

		// The browser that began redeems: a session cookie for this host only.
		const redeemed = await redeem(orgA, handoffCookie);
		expect(redeemed.response.status(), redeemed.body).toBe(200);
		expect(JSON.parse(redeemed.body)).toEqual({ returnTo: "/dashboard" });
		const lines = cookiePairs(redeemed.response);
		expect(lines.some((line) => /session_token=[^;]+/.test(line))).toBe(true);
		expect(lines.join("\n")).not.toMatch(/Domain=/i);
		const orgCookie = cookieHeader(lines);

		// It is a working session on Organization A's host, with Organization A active.
		const session = await send(playwright, baseURL, {
			method: "GET",
			path: "/api/auth/get-session?disableCookieCache=true",
			host: orgA.host,
			cookie: orgCookie,
		});
		const current = JSON.parse(session.body) as { user: { id: string }; session: { activeOrganizationId?: string } };
		expect(current.user.id).toBe(userId);
		expect(current.session.activeOrganizationId).toBe(orgA.id);

		// A second redeem of the same token is refused.
		const replay = await redeem(orgA, handoffCookie);
		expect(replay.response.status()).toBe(400);
		expect(JSON.parse(replay.body)).toEqual({ code: "handoff_invalid" });

		// A member of nothing on an invite-only organization is sent to the access page, with no token.
		const closed = await begin(orgB);
		expect(closed.response.status()).toBe(200);
		const closedId = new URL((JSON.parse(closed.body) as { url: string }).url).searchParams.get("request") ?? "";
		const outsider = await send(playwright, baseURL, {
			method: "GET",
			path: `/api/careeros/handoff/issue?request=${closedId}`,
			cookie: platformCookie,
		});
		expect(outsider.response.headers().location).toBe(`${orgB.origin}/auth/organization-access`);

		// The browser half: the redeem page reads the fragment, clears it, redeems and lands on the dashboard.
		const second = await begin(orgA);
		const secondId = new URL((JSON.parse(second.body) as { url: string }).url).searchParams.get("request") ?? "";
		const secondVerifier = /careeros_handoff=([^;]*)/.exec(cookiePairs(second.response).join("\n"))?.[1] ?? "";
		const freshPlatform = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
		const second2 = await freshPlatform.post("/api/auth/sign-in/email", {
			data: { email: account.email, password: account.password },
		});
		expect(second2.ok()).toBe(true);
		const issuedAgain = await send(playwright, baseURL, {
			method: "GET",
			path: `/api/careeros/handoff/issue?request=${secondId}`,
			cookie: cookieHeader(cookiePairs(second2)),
		});
		await freshPlatform.dispose();
		const secondFragment = new URL(issuedAgain.response.headers().location ?? "").hash;
		const context = await browser.newContext();
		try {
			await context.addCookies([
				{
					name: "careeros_handoff",
					value: secondVerifier,
					domain: `${orgA.slug}.orgs.test`,
					path: "/api/careeros/handoff",
				},
			]);
			const page = await context.newPage();
			await page.goto(`${orgA.origin}/auth/handoff/redeem${secondFragment}`);
			await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
			expect(page.url()).not.toContain("token=");
			const cookies = await context.cookies(orgA.origin);
			const sessionCookie = cookies.find((cookie) => cookie.name.endsWith("session_token"));
			// Host-only: the cookie's domain is the organization's host, not a parent domain.
			expect(sessionCookie?.domain).toBe(`${orgA.slug}.orgs.test`);
		} finally {
			await context.close();
		}
	} finally {
		await withSeedPool(async (pool) => {
			await pool.query("delete from organization where id = any($1::text[])", [[orgA.id, orgB.id]]);
		});
	}
});
