import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";

// P5-T02: the Job Clipper's device sign-in end to end, against a database of its own (every migration applied) with the
// real Better Auth configuration, the real host resolver and the real Hono app, as the `careeros_app` role. Skipped only
// when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

// The shared setup file replaces the tenancy module; this test needs the real host resolver and organization scope.
vi.unmock("@careeros/tenancy");
vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

const PASSWORD = "correct-horse-battery";
const PLATFORM = "localhost:3000";
const PLATFORM_ORIGIN = `http://${PLATFORM}`;
const CLIENT_ID = "careeros-job-clipper";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const USER_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const CHROME =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe.skipIf(!configured)("Job Clipper sign-in", () => {
	const run = randomUUID().slice(0, 8);
	const orgs = {
		a: { id: `ca-${run}`, slug: `ca-${run}`, domain: `jobs-a-${run}.example.test` },
		b: { id: `cb-${run}`, slug: `cb-${run}`, domain: `jobs-b-${run}.example.test` },
	};
	const hostOf = (org: { slug: string }) => `${org.slug}.orgs.test`;
	const originOf = (org: { slug: string }) => `http://${hostOf(org)}`;
	const domainOrigin = (org: { domain: string }) => `http://${org.domain}`;

	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let auth: typeof import("@reactive-resume/auth/config").auth;
	let hono: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

	const call = async (url: string, init: RequestInit = {}) => await hono.request(url, init);
	const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
	const cookieHeader = (response: Response) =>
		response.headers
			.getSetCookie()
			.map((line) => line.split(";", 1)[0])
			.filter((pair) => !pair?.endsWith("="))
			.join("; ");

	/** An account and its session cookie. The cookie is just a session token; the host's rules decide what it may do. */
	const account = async (label = "u") => {
		const suffix = randomUUID().slice(0, 8);
		const email = `${label}-${suffix}@example.test`;
		const response = await auth.handler(
			new Request(`${PLATFORM_ORIGIN}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { host: PLATFORM, "content-type": "application/json", origin: PLATFORM_ORIGIN },
				body: JSON.stringify({ name: `Name ${label}`, email, password: PASSWORD, username: `${label}-${suffix}` }),
			}),
		);
		expect(response.status).toBe(200);
		const row = await owner.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
		return { email, userId: row.rows[0]?.id ?? "", cookie: cookieHeader(response) };
	};
	const addMember = (organizationId: string, userId: string) =>
		owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
			`m-${randomUUID()}`,
			organizationId,
			userId,
		]);
	const member = async (org: { id: string }, label = "member") => {
		const user = await account(label);
		await addMember(org.id, user.userId);
		return user;
	};

	// The device flow, as the extension and the approval page drive it.
	const auth_ = (origin: string, path: string, init: RequestInit = {}) =>
		call(`${origin}/api/auth${path}`, {
			...init,
			headers: { origin, "content-type": "application/json", "user-agent": CHROME, ...(init.headers as object) },
		});
	const requestCode = (origin: string, body: Record<string, unknown> = { client_id: CLIENT_ID }) =>
		auth_(origin, "/device/code", { method: "POST", body: JSON.stringify(body) });
	const verify = (origin: string, userCode: string, cookie?: string) =>
		auth_(origin, `/device?user_code=${encodeURIComponent(userCode)}`, { headers: cookie ? { cookie } : {} });
	const approve = (origin: string, userCode: string, cookie: string) =>
		auth_(origin, "/device/approve", { method: "POST", body: JSON.stringify({ userCode }), headers: { cookie } });
	const deny = (origin: string, userCode: string, cookie: string) =>
		auth_(origin, "/device/deny", { method: "POST", body: JSON.stringify({ userCode }), headers: { cookie } });
	const poll = (origin: string, deviceCode: string, clientId = CLIENT_ID) =>
		auth_(origin, "/device/clipper/token", {
			method: "POST",
			body: JSON.stringify({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: deviceCode,
				client_id: clientId,
			}),
		});
	/** The polling interval is enforced by the plugin; the tests step over it by moving the last poll back. */
	const waitInterval = (deviceCode: string) =>
		owner.query(`UPDATE device_code SET last_polled_at = now() - interval '10 seconds' WHERE device_code = $1`, [
			deviceCode,
		]);

	type Code = { device_code: string; user_code: string };
	const newCode = async (origin: string): Promise<Code> => {
		const response = await requestCode(origin);
		expect(response.status).toBe(200);
		return (await json(response)) as Code;
	};
	/** A signed-in clipper token for `user` on `org`: request, claim, approve, redeem. */
	const signIn = async (org: { id: string; slug: string }, user?: { userId: string; cookie: string }) => {
		const who = user ?? (await member(org));
		const code = await newCode(originOf(org));
		expect((await verify(originOf(org), code.user_code, who.cookie)).status).toBe(200);
		expect((await approve(originOf(org), code.user_code, who.cookie)).status).toBe(200);
		const redeemed = await poll(originOf(org), code.device_code);
		expect(redeemed.status).toBe(200);
		const body = await json(redeemed);
		return { who, code, token: String(body.access_token), body };
	};

	const api = (origin: string, path: string, token: string, init: RequestInit = {}) =>
		call(`${origin}/api/openapi${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, origin, ...(init.headers as object) },
		});
	const tokenRows = async (userId: string) =>
		(await owner.query<Record<string, unknown>>(`SELECT * FROM clipper_token WHERE user_id = $1`, [userId])).rows;

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("clipper_t02");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.ORG_HOST_PATTERN = "{slug}.orgs.test";
		process.env.APP_URL = PLATFORM_ORIGIN;
		process.env.TRUST_FORWARDED_HOST = "false";
		// Custom domains of an organization are on only when these settings exist; the CNAME target is never contacted.
		process.env.CF_SAAS_API_TOKEN = "cf-integration-token-NEVER-LOG-ME";
		process.env.CF_ZONE_ID = "0123456789abcdef0123456789abcdef";
		process.env.CF_SAAS_CNAME_TARGET = "saas.customers.example.test";
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		for (const org of Object.values(orgs)) {
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [
				org.id,
				`Org ${org.slug}`,
				org.slug,
			]);
			await owner.query(
				`INSERT INTO organization_domain (id, organization_id, hostname, status, verification_token) VALUES ($1, $2, $3, 'active', 'token')`,
				[`dom-${org.id}`, org.id, org.domain],
			);
		}
		({ auth } = await import("@reactive-resume/auth/config"));
		const { createApp } = await import("./app");
		hono = createApp({ serveStatic: false, trustedClient: () => "203.0.113.9" });
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	describe("the device flow", () => {
		it("signs a member in end to end and stores only a hash", async () => {
			const response = await requestCode(originOf(orgs.a));
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			const code = (await json(response)) as Code & { expires_in: number; interval: number };
			expect(code.user_code).toMatch(USER_CODE);
			expect(code.expires_in).toBe(600);
			expect(code.interval).toBe(5);

			// The code records the host it was requested on and that host's organization, from the host alone.
			const stored = (await owner.query(`SELECT * FROM device_code WHERE device_code = $1`, [code.device_code]))
				.rows[0];
			expect(stored).toMatchObject({
				organization_id: orgs.a.id,
				request_host: hostOf(orgs.a),
				client_id: CLIENT_ID,
				status: "pending",
			});

			// Not approved yet.
			expect(await json(await poll(originOf(orgs.a), code.device_code))).toMatchObject({
				error: "authorization_pending",
			});

			const user = await member(orgs.a);
			const reviewed = await json(await verify(originOf(orgs.a), code.user_code, user.cookie));
			expect(reviewed).toMatchObject({ status: "pending", client_id: CLIENT_ID, request_host: hostOf(orgs.a) });
			expect((await approve(originOf(orgs.a), code.user_code, user.cookie)).status).toBe(200);

			await waitInterval(code.device_code);
			const redeemed = await poll(originOf(orgs.a), code.device_code);
			expect(redeemed.status).toBe(200);
			expect(redeemed.headers.get("cache-control")).toBe("no-store");
			const body = await json(redeemed);
			const token = String(body.access_token);
			expect(token).toMatch(/^cos_clip_[A-Za-z0-9_-]{43}$/);
			expect(body).toMatchObject({ token_type: "Bearer", scope: "clipper", expires_in: 90 * 24 * 60 * 60 });
			expect(body.user_name).toBe("Name member");

			// A code redeems once, and the device code row is gone.
			await waitInterval(code.device_code);
			expect(await json(await poll(originOf(orgs.a), code.device_code))).toMatchObject({ error: "invalid_grant" });
			expect((await owner.query(`SELECT 1 FROM device_code WHERE device_code = $1`, [code.device_code])).rowCount).toBe(
				0,
			);

			// The token is stored as a SHA-256 and nowhere else; no session was created for the clipper.
			const rows = await tokenRows(user.userId);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				token_hash: sha256(token),
				organization_id: orgs.a.id,
				host: hostOf(orgs.a),
				label: "Chrome on Windows",
			});
			expect(JSON.stringify(rows)).not.toContain(token);
			const dump =
				JSON.stringify((await owner.query(`SELECT * FROM device_code`)).rows) +
				JSON.stringify((await owner.query(`SELECT value FROM verification`)).rows);
			expect(dump).not.toContain(token);
			expect((await owner.query(`SELECT 1 FROM session WHERE token = $1`, [token])).rowCount).toBe(0);
			const days = Number(
				(
					await owner.query(
						`SELECT extract(epoch FROM expires_at - now()) / 86400 AS d FROM clipper_token WHERE user_id = $1`,
						[user.userId],
					)
				).rows[0]?.d,
			);
			expect(days).toBeGreaterThan(89.9);
			expect(days).toBeLessThanOrEqual(90);
		});

		it("accepts only the clipper's client id and an organization host", async () => {
			const wrongClient = await requestCode(originOf(orgs.a), { client_id: "someone-else" });
			expect(wrongClient.status).toBe(400);
			expect(await json(wrongClient)).toMatchObject({ error: "invalid_client" });
			expect((await requestCode(originOf(orgs.a), { client_id: CLIENT_ID, user_id: "u1" })).status).toBe(400);
			expect((await requestCode(originOf(orgs.a), { client_id: CLIENT_ID, scope: "openid" })).status).toBe(400);
			const platform = await requestCode(PLATFORM_ORIGIN);
			expect(platform.status).toBe(400);
			expect(await json(platform)).toMatchObject({ error: "unauthorized_client" });
			// The redemption names the client too.
			const code = await newCode(originOf(orgs.a));
			const other = await poll(originOf(orgs.a), code.device_code, "someone-else");
			expect(other.status).toBe(400);
		});

		it("never turns a device code into a browser session", async () => {
			const user = await member(orgs.a);
			const code = await newCode(originOf(orgs.a));
			await verify(originOf(orgs.a), code.user_code, user.cookie);
			await approve(originOf(orgs.a), code.user_code, user.cookie);
			await waitInterval(code.device_code);
			const session = await auth_(originOf(orgs.a), "/device/token", {
				method: "POST",
				body: JSON.stringify({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: code.device_code,
					client_id: CLIENT_ID,
				}),
			});
			expect(session.status).toBe(404);
			// The code is untouched and still redeems for a clipper token.
			expect((await poll(originOf(orgs.a), code.device_code)).status).toBe(200);
		});

		it("slows a client that polls too fast", async () => {
			const code = await newCode(originOf(orgs.a));
			expect((await json(await poll(originOf(orgs.a), code.device_code))).error).toBe("authorization_pending");
			expect((await json(await poll(originOf(orgs.a), code.device_code))).error).toBe("slow_down");
		});

		it("reports a denied and an expired code", async () => {
			const user = await member(orgs.a);
			const denied = await newCode(originOf(orgs.a));
			await verify(originOf(orgs.a), denied.user_code, user.cookie);
			expect((await deny(originOf(orgs.a), denied.user_code, user.cookie)).status).toBe(200);
			await waitInterval(denied.device_code);
			expect((await json(await poll(originOf(orgs.a), denied.device_code))).error).toBe("access_denied");

			const expired = await newCode(originOf(orgs.a));
			await owner.query(`UPDATE device_code SET expires_at = now() - interval '1 minute' WHERE device_code = $1`, [
				expired.device_code,
			]);
			expect((await json(await poll(originOf(orgs.a), expired.device_code))).error).toBe("expired_token");
			expect((await verify(originOf(orgs.a), expired.user_code, user.cookie)).status).toBe(400);
		});
	});

	describe("host binding of the approval", () => {
		it("refuses to verify, approve or deny on another host, as if the code did not exist", async () => {
			const code = await newCode(originOf(orgs.a));
			const both = await member(orgs.a, "both");
			await addMember(orgs.b.id, both.userId);
			// A member of both organizations, on organization B's host, the platform host and B's custom domain.
			for (const origin of [originOf(orgs.b), PLATFORM_ORIGIN, domainOrigin(orgs.b)]) {
				const verified = await verify(origin, code.user_code, both.cookie);
				expect(verified.status).toBe(400);
				expect(await json(verified)).toMatchObject({ error: "invalid_request" });
				expect((await approve(origin, code.user_code, both.cookie)).status).toBe(400);
				expect((await deny(origin, code.user_code, both.cookie)).status).toBe(400);
			}
			// Nothing moved: the code is still pending and unclaimed.
			expect(
				(await owner.query(`SELECT status, user_id FROM device_code WHERE device_code = $1`, [code.device_code]))
					.rows[0],
			).toEqual({ status: "pending", user_id: null });
		});

		it("refuses a signed-in person who is not a member of the host's organization", async () => {
			const code = await newCode(originOf(orgs.a));
			const outsider = await account("outsider");
			const verified = await verify(originOf(orgs.a), code.user_code, outsider.cookie);
			expect(verified.status).toBe(403);
			expect(await json(verified)).toMatchObject({ error: "access_denied" });
			expect((await approve(originOf(orgs.a), code.user_code, outsider.cookie)).status).toBe(403);
			expect(
				(await owner.query(`SELECT user_id FROM device_code WHERE device_code = $1`, [code.device_code])).rows[0],
			).toEqual({ user_id: null });
		});

		it("approves on the organization's custom domain as the same organization", async () => {
			const user = await member(orgs.a);
			const code = await newCode(originOf(orgs.a));
			expect((await verify(domainOrigin(orgs.a), code.user_code, user.cookie)).status).toBe(200);
			expect((await approve(domainOrigin(orgs.a), code.user_code, user.cookie)).status).toBe(200);
		});

		it("refuses to redeem a code on another host, and leaves it redeemable on its own", async () => {
			const user = await member(orgs.a);
			const code = await newCode(originOf(orgs.a));
			await verify(originOf(orgs.a), code.user_code, user.cookie);
			await approve(originOf(orgs.a), code.user_code, user.cookie);
			await waitInterval(code.device_code);
			for (const origin of [originOf(orgs.b), PLATFORM_ORIGIN, domainOrigin(orgs.b)]) {
				const response = await poll(origin, code.device_code);
				expect(response.status).toBe(400);
				expect(await json(response)).toMatchObject({ error: "invalid_grant" });
			}
			expect((await tokenRows(user.userId)).length).toBe(0);
			expect((await poll(originOf(orgs.a), code.device_code)).status).toBe(200);
		});

		it("refuses to redeem once the approver left the organization", async () => {
			const user = await member(orgs.a);
			const code = await newCode(originOf(orgs.a));
			await verify(originOf(orgs.a), code.user_code, user.cookie);
			await approve(originOf(orgs.a), code.user_code, user.cookie);
			await owner.query(`DELETE FROM member WHERE organization_id = $1 AND user_id = $2`, [orgs.a.id, user.userId]);
			await waitInterval(code.device_code);
			const response = await poll(originOf(orgs.a), code.device_code);
			expect([400, 403]).toContain(response.status);
			expect((await tokenRows(user.userId)).length).toBe(0);
		});
	});

	// The extension's popup is a page of its own origin. When the browser has not granted it host access to the
	// organization's address, the browser asks the server (CORS), so these routes must answer an extension origin.
	describe("an extension page without host access (CORS)", () => {
		const extension = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
		const preflight = (path: string, method: string, headers: string) =>
			call(`${originOf(orgs.a)}${path}`, {
				method: "OPTIONS",
				headers: {
					origin: extension,
					"access-control-request-method": method,
					"access-control-request-headers": headers,
				},
			});

		it("answers the preflight of each clipper route, and only those", async () => {
			for (const [path, method, headers] of [
				["/api/auth/device/code", "POST", "content-type"],
				["/api/auth/device/clipper/token", "POST", "content-type"],
				["/api/auth/device/clipper/revoke", "POST", "authorization,content-type"],
				["/api/openapi/clipper/whoami", "GET", "authorization"],
			] as const) {
				const response = await preflight(path, method, headers);
				expect(response.status, path).toBe(204);
				expect(response.headers.get("access-control-allow-origin"), path).toBe(extension);
				expect(response.headers.get("access-control-allow-credentials"), path).toBeNull();
				expect(response.headers.get("access-control-allow-headers"), path).toContain("Authorization");
			}
			// Everything else keeps no CORS: the approval endpoints, the token list and revoke-by-id are page-only.
			for (const path of ["/api/auth/device/approve", "/api/auth/device/deny", "/api/openapi/clipper/tokens"]) {
				const response = await preflight(path, "POST", "content-type");
				expect(response.headers.get("access-control-allow-origin"), path).toBeNull();
			}
		});

		it("lets the extension start a sign-in and then use its token, with no cookie", async () => {
			const started = await call(`${originOf(orgs.a)}/api/auth/device/code`, {
				method: "POST",
				headers: { origin: extension, "content-type": "application/json", "user-agent": CHROME },
				body: JSON.stringify({ client_id: CLIENT_ID }),
			});
			expect(started.status).toBe(200);
			expect(started.headers.get("access-control-allow-origin")).toBe(extension);
			expect(started.headers.get("access-control-allow-credentials")).toBeNull();
			expect(await json(started)).toMatchObject({ device_code: expect.any(String) });

			const { token } = await signIn(orgs.a);
			const whoami = await call(`${originOf(orgs.a)}/api/openapi/clipper/whoami`, {
				headers: { origin: extension, authorization: `Bearer ${token}` },
			});
			expect(whoami.status).toBe(200);
			expect(whoami.headers.get("access-control-allow-origin")).toBe(extension);
			// The same token from an extension page is still refused on another organization's host.
			const other = await call(`${originOf(orgs.b)}/api/openapi/clipper/whoami`, {
				headers: { origin: extension, authorization: `Bearer ${token}` },
			});
			expect(other.status).toBe(401);
		});

		it("gives a web page of another origin no CORS headers", async () => {
			const response = await call(`${originOf(orgs.a)}/api/auth/device/code`, {
				method: "OPTIONS",
				headers: {
					origin: "https://evil.example",
					"access-control-request-method": "POST",
					"access-control-request-headers": "content-type",
				},
			});
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
		});
	});

	describe("a clipper token", () => {
		it("works on its organization's subdomain and custom domain", async () => {
			const { token, who } = await signIn(orgs.a);
			for (const origin of [originOf(orgs.a), domainOrigin(orgs.a)]) {
				const response = await api(origin, "/clipper/whoami", token);
				expect(response.status).toBe(200);
				const body = await json(response);
				expect(body).toMatchObject({ name: "Name member", organizationName: `Org ${orgs.a.slug}` });
				expect(typeof body.expiresAt).toBe("string");
			}
			expect((await tokenRows(who.userId))[0]?.last_used_at).not.toBeNull();
			// The branding of the address is allowed too.
			expect((await api(originOf(orgs.a), "/branding/host", token)).status).toBe(200);
		});

		it("is refused with 401 on another organization's host, its custom domain and the platform host", async () => {
			const { token } = await signIn(orgs.a);
			const both = await member(orgs.b, "otherorg");
			await signIn(orgs.b, both); // organization B has its own working sign-in, so B's hosts are live
			for (const origin of [originOf(orgs.b), domainOrigin(orgs.b), PLATFORM_ORIGIN]) {
				for (const path of ["/clipper/whoami", "/branding/host", "/applications"]) {
					const response = await api(origin, path, token);
					expect(response.status, `${origin}${path}`).toBe(401);
				}
				expect(
					(
						await api(origin, "/applications", token, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: "{}",
						})
					).status,
				).toBe(401);
			}
			// And the same on the RPC adapter.
			const rpc = await call(`${originOf(orgs.b)}/api/rpc/clipper/whoami`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: originOf(orgs.b) },
				body: JSON.stringify({ json: {} }),
			});
			expect(rpc.status).toBe(401);
		});

		it("cannot call a procedure outside the allow-list, on its own host", async () => {
			const { token } = await signIn(orgs.a);
			for (const [method, path] of [
				["GET", "/applications"],
				["GET", "/auth/profile"],
				["GET", "/resumes"],
				["GET", "/clipper/tokens"],
				["GET", "/branding"],
				["GET", "/organization/settings"],
			] as const) {
				const response = await api(originOf(orgs.a), path, token, { method });
				expect(response.status, `${method} ${path}`).toBe(403);
			}
			const revoke = await api(originOf(orgs.a), "/clipper/tokens/anything", token, { method: "DELETE" });
			expect(revoke.status).toBe(403);
			const rpc = await call(`${originOf(orgs.a)}/api/rpc/auth/getProfile`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: originOf(orgs.a) },
				body: JSON.stringify({ json: {} }),
			});
			expect(rpc.status).toBe(403);
		});

		it("is not a credential for anything outside the oRPC procedures", async () => {
			const { token } = await signIn(orgs.a);
			// The auth endpoints see no session for it.
			const session = await call(`${originOf(orgs.a)}/api/auth/get-session`, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(await session.text()).toBe("null");
		});

		it("slides its expiry once 30 days or fewer remain, and not before", async () => {
			const { token, who } = await signIn(orgs.a);
			const expiry = async () =>
				Number(
					(
						await owner.query(
							`SELECT extract(epoch FROM expires_at - now()) / 86400 AS d FROM clipper_token WHERE user_id = $1`,
							[who.userId],
						)
					).rows[0]?.d,
				);
			await owner.query(`UPDATE clipper_token SET expires_at = now() + interval '60 days' WHERE user_id = $1`, [
				who.userId,
			]);
			expect((await api(originOf(orgs.a), "/clipper/whoami", token)).status).toBe(200);
			expect(await expiry()).toBeCloseTo(60, 0);
			await owner.query(`UPDATE clipper_token SET expires_at = now() + interval '10 days' WHERE user_id = $1`, [
				who.userId,
			]);
			expect((await api(originOf(orgs.a), "/clipper/whoami", token)).status).toBe(200);
			expect(await expiry()).toBeGreaterThan(89.9);
		});

		it("is refused once expired", async () => {
			const { token, who } = await signIn(orgs.a);
			await owner.query(`UPDATE clipper_token SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [
				who.userId,
			]);
			expect((await api(originOf(orgs.a), "/clipper/whoami", token)).status).toBe(401);
			expect((await tokenRows(who.userId)).length).toBe(0);
		});

		it("is refused when it is made up or tampered with", async () => {
			const { token } = await signIn(orgs.a);
			expect(
				(await api(originOf(orgs.a), "/clipper/whoami", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`))
					.status,
			).toBe(401);
			expect((await api(originOf(orgs.a), "/clipper/whoami", `cos_clip_${"a".repeat(43)}`)).status).toBe(401);
		});
	});

	describe("revocation", () => {
		it("lists a member's sign-ins and revokes one on the next request", async () => {
			const user = await member(orgs.a, "lister");
			const first = await signIn(orgs.a, user);
			const second = await signIn(orgs.a, user);
			const listed = await call(`${originOf(orgs.a)}/api/openapi/clipper/tokens`, {
				headers: { cookie: user.cookie, origin: originOf(orgs.a) },
			});
			expect(listed.status).toBe(200);
			const rows = (await listed.json()) as { id: string; organizationName: string; label: string; host: string }[];
			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({
				organizationName: `Org ${orgs.a.slug}`,
				label: "Chrome on Windows",
				host: hostOf(orgs.a),
			});
			expect(JSON.stringify(rows)).not.toContain(first.token);
			expect(Object.keys(rows[0] ?? {})).not.toContain("tokenHash");

			const target = (await tokenRows(user.userId)).find((row) => row.token_hash === sha256(first.token));
			const revoked = await call(`${originOf(orgs.a)}/api/openapi/clipper/tokens/${String(target?.id)}`, {
				method: "DELETE",
				headers: { cookie: user.cookie, origin: originOf(orgs.a) },
			});
			expect(revoked.status).toBe(200);
			expect(await json(revoked)).toEqual({ revoked: true });
			expect((await api(originOf(orgs.a), "/clipper/whoami", first.token)).status).toBe(401);
			expect((await api(originOf(orgs.a), "/clipper/whoami", second.token)).status).toBe(200);
		});

		it("cannot revoke another member's sign-in", async () => {
			const mine = await member(orgs.a, "mine");
			const theirs = await signIn(orgs.a);
			const target = (await tokenRows(theirs.who.userId))[0];
			const response = await call(`${originOf(orgs.a)}/api/openapi/clipper/tokens/${String(target?.id)}`, {
				method: "DELETE",
				headers: { cookie: mine.cookie, origin: originOf(orgs.a) },
			});
			expect(await json(response)).toEqual({ revoked: false });
			expect((await api(originOf(orgs.a), "/clipper/whoami", theirs.token)).status).toBe(200);
		});

		it("signs out from the extension with the token itself", async () => {
			const { token } = await signIn(orgs.a);
			const out = await auth_(originOf(orgs.a), "/device/clipper/revoke", {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
			});
			expect(out.status).toBe(200);
			expect((await api(originOf(orgs.a), "/clipper/whoami", token)).status).toBe(401);
			// Signing out twice is not an error.
			expect(
				(
					await auth_(originOf(orgs.a), "/device/clipper/revoke", {
						method: "POST",
						headers: { authorization: `Bearer ${token}` },
					})
				).status,
			).toBe(200);
		});

		it("ends when the member is removed from the organization, only for that organization", async () => {
			const user = await member(orgs.a, "leaver");
			await addMember(orgs.b.id, user.userId);
			const inA = await signIn(orgs.a, user);
			const inB = await signIn(orgs.b, user);
			await owner.query(`DELETE FROM member WHERE organization_id = $1 AND user_id = $2`, [orgs.a.id, user.userId]);
			expect((await api(originOf(orgs.a), "/clipper/whoami", inA.token)).status).toBe(401);
			expect((await tokenRows(user.userId)).map((row) => row.organization_id)).toEqual([orgs.b.id]);
			expect((await api(originOf(orgs.b), "/clipper/whoami", inB.token)).status).toBe(200);
		});

		it("ends when the account is deleted or suspended", async () => {
			const banned = await signIn(orgs.a);
			await owner.query(`UPDATE "user" SET banned = true WHERE id = $1`, [banned.who.userId]);
			expect((await tokenRows(banned.who.userId)).length).toBe(0);
			expect((await api(originOf(orgs.a), "/clipper/whoami", banned.token)).status).toBe(401);

			const deleted = await signIn(orgs.a);
			await owner.query(`DELETE FROM "user" WHERE id = $1`, [deleted.who.userId]);
			expect((await api(originOf(orgs.a), "/clipper/whoami", deleted.token)).status).toBe(401);
		});
	});
});
