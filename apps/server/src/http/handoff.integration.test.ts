import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";

// P2-T05: the social and OIDC sign-in handoff end to end, against a database of its own (every migration applied) with
// the real Better Auth configuration, the real host resolver and the real Hono app, as the `careeros_app` role. The
// provider's redirect round trip is replaced by a platform session seeded with email sign-up: the issue step only
// ever sees "a platform session exists", whichever way it got there. Skipped only when the CAREEROS_TEST_* variables
// are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

// The shared setup file replaces the tenancy module; this test needs the real host resolver and organization scope.
vi.unmock("@careeros/tenancy");
vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

const PASSWORD = "correct-horse-battery";
const PLATFORM = "localhost:3000";
const PLATFORM_ORIGIN = `http://${PLATFORM}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!configured)("sign-in handoff to an organization host", () => {
	const run = randomUUID().slice(0, 8);
	const orgs = {
		a: { id: `ha-${run}`, slug: `ha-${run}` },
		b: { id: `hb-${run}`, slug: `hb-${run}` },
		open: { id: `ho-${run}`, slug: `ho-${run}` },
		closed: { id: `hc-${run}`, slug: `hc-${run}` },
	};
	const hostOf = (org: { slug: string }) => `${org.slug}.orgs.test`;
	const originOf = (org: { slug: string }) => `http://${hostOf(org)}`;

	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let auth: typeof import("@reactive-resume/auth/config").auth;
	let hono: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
	let service: typeof import("@reactive-resume/api/features/auth-handoff");

	const logs: unknown[][] = [];
	afterEach(() => {
		logs.length = 0;
		vi.restoreAllMocks();
	});

	const call = async (url: string, init: RequestInit = {}) => await hono.request(url, init);
	const cookieHeader = (response: Response) =>
		response.headers
			.getSetCookie()
			.map((line) => line.split(";", 1)[0])
			.filter((pair) => !pair?.endsWith("="))
			.join("; ");
	const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

	/** A platform account and its session cookie (what the provider callback leaves behind). */
	const platformSession = async (label = "u") => {
		const suffix = randomUUID().slice(0, 8);
		const email = `${label}-${suffix}@example.test`;
		const response = await auth.handler(
			new Request(`${PLATFORM_ORIGIN}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { host: PLATFORM, "content-type": "application/json", origin: PLATFORM_ORIGIN },
				body: JSON.stringify({ name: label, email, password: PASSWORD, username: `${label}-${suffix}` }),
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
	const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

	type Begun = { id: string; verifier: string; response: Response };
	const begin = async (
		org: { slug: string },
		body: Record<string, unknown> = {},
		headers: Record<string, string> = {},
	): Promise<Begun> => {
		const response = await call(`${originOf(org)}/api/careeros/handoff/begin`, {
			method: "POST",
			headers: { origin: originOf(org), "content-type": "application/json", ...headers },
			body: JSON.stringify({ provider: "google", returnTo: "/resumes?x=1", ...body }),
		});
		const verifier = /careeros_handoff=([^;]*)/.exec(response.headers.getSetCookie().join("\n"))?.[1] ?? "";
		const url = response.status === 200 ? String((await response.clone().json()).url) : "";
		const id = url ? (new URL(url).searchParams.get("request") ?? "") : "";
		return { id, verifier, response };
	};
	const issue = (id: string, cookie?: string) =>
		call(`${PLATFORM_ORIGIN}/api/careeros/handoff/issue?request=${encodeURIComponent(id)}`, {
			headers: { host: PLATFORM, ...(cookie ? { cookie } : {}) },
		});
	/** The token and request id a successful issue puts in the redirect's fragment. */
	const fragmentOf = (response: Response) => {
		const location = new URL(response.headers.get("location") ?? "");
		const fragment = new URLSearchParams(location.hash.slice(1));
		return { location, token: fragment.get("token") ?? "", request: fragment.get("request") ?? "" };
	};
	const redeem = (
		org: { slug: string },
		body: Record<string, unknown>,
		verifier: string | undefined,
		headers: Record<string, string> = {},
	) =>
		call(`${originOf(org)}/api/careeros/handoff/redeem`, {
			method: "POST",
			headers: {
				origin: originOf(org),
				"content-type": "application/json",
				...(verifier === undefined ? {} : { cookie: `careeros_handoff=${verifier}` }),
				...headers,
			},
			body: JSON.stringify(body),
		});
	const row = async (id: string) =>
		(
			await owner.query<Record<string, unknown>>(
				`SELECT *, token_expires_at > now() AS token_live FROM auth_handoff WHERE id = $1`,
				[id],
			)
		).rows[0];
	/** begin on `org`, then issue for a fresh member of it: ready to redeem. */
	const issued = async (org: { id: string; slug: string }, begun?: Begun) => {
		const started = begun ?? (await begin(org));
		const user = await platformSession("member");
		await addMember(org.id, user.userId);
		const response = await issue(started.id, user.cookie);
		return { ...started, user, response, ...fragmentOf(response) };
	};

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("handoff_t05");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.ORG_HOST_PATTERN = "{slug}.orgs.test";
		process.env.APP_URL = PLATFORM_ORIGIN;
		process.env.GOOGLE_CLIENT_ID = "google-client";
		process.env.GOOGLE_CLIENT_SECRET = "google-secret";
		process.env.TRUST_FORWARDED_HOST = "false";
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		for (const org of Object.values(orgs))
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [
				org.id,
				`Org ${org.slug}`,
				org.slug,
			]);
		await owner.query(`UPDATE organization_settings SET open_signup = true WHERE organization_id = $1`, [orgs.open.id]);
		({ auth } = await import("@reactive-resume/auth/config"));
		service = await import("@reactive-resume/api/features/auth-handoff");
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

	describe("the happy path", () => {
		it("begins, issues and redeems into a session on the organization host only", async () => {
			const begun = await begin(orgs.a, { returnTo: "/resumes?x=1" });
			expect(begun.response.status).toBe(200);
			const body = await json(begun.response);
			expect(body.url).toBe(`${PLATFORM_ORIGIN}/auth/handoff?request=${begun.id}`);
			expect(begun.id.length).toBeGreaterThanOrEqual(22); // 128 bits or more in base64url

			// The verifier cookie: host-only (no Domain), HttpOnly, Lax, scoped to the handoff path, ten minutes.
			const cookie = begun.response.headers.getSetCookie().find((line) => line.startsWith("careeros_handoff="));
			expect(cookie).toMatch(/HttpOnly/);
			expect(cookie).toMatch(/SameSite=Lax/);
			expect(cookie).toMatch(/Path=\/api\/careeros\/handoff/);
			expect(cookie).toMatch(/Max-Age=600/);
			expect(cookie).not.toMatch(/Domain=/i);
			expect(cookie).not.toMatch(/Secure/); // http origin

			// What is stored: hashes, the host's origin, the organization, and a database-time expiry.
			const stored = await row(begun.id);
			expect(stored).toMatchObject({
				organization_id: orgs.a.id,
				target_origin: originOf(orgs.a),
				return_to: "/resumes?x=1",
				provider: "google",
				browser_binding_hash: sha256(begun.verifier),
				token_hash: null,
				user_id: null,
				redeemed_at: null,
			});
			expect(JSON.stringify(stored)).not.toContain(begun.verifier);
			const minutes = await owner.query<{ minutes: number }>(
				`SELECT extract(epoch FROM expires_at - created_at) / 60 AS minutes FROM auth_handoff WHERE id = $1`,
				[begun.id],
			);
			expect(Number(minutes.rows[0]?.minutes)).toBeCloseTo(10, 1);

			// The platform page asks what to start.
			const info = await call(`${PLATFORM_ORIGIN}/api/careeros/handoff/request/${begun.id}`);
			expect(info.status).toBe(200);
			expect(await info.json()).toEqual({ provider: "google", organizationName: `Org ${orgs.a.slug}` });

			// Issue, as a member who just signed in on the platform host.
			await pause();
			const user = await platformSession("happy");
			await addMember(orgs.a.id, user.userId);
			const platformSessions = async () =>
				Number(
					(await owner.query(`SELECT count(*)::int AS n FROM session WHERE user_id = $1`, [user.userId])).rows[0]?.n,
				);
			expect(await platformSessions()).toBe(1);
			const issuedResponse = await issue(begun.id, user.cookie);
			expect(issuedResponse.status).toBe(302);
			expect(issuedResponse.headers.get("referrer-policy")).toBe("no-referrer");
			expect(issuedResponse.headers.get("cache-control")).toBe("no-store");
			const { location, token, request } = fragmentOf(issuedResponse);
			expect(`${location.origin}${location.pathname}`).toBe(`${originOf(orgs.a)}/auth/handoff/redeem`);
			expect(location.search).toBe(""); // the token is in the fragment, never in the query
			expect(request).toBe(begun.id);
			expect(token.length).toBeGreaterThanOrEqual(43); // 256 bits
			// The platform session this flow created is gone, and its cookie is expired in the reply.
			expect(await platformSessions()).toBe(0);
			expect(issuedResponse.headers.getSetCookie().join("\n")).toMatch(/session_token=;/);
			const afterIssue = await row(begun.id);
			expect(afterIssue).toMatchObject({ token_hash: sha256(token), user_id: user.userId, token_live: true });
			expect(JSON.stringify(afterIssue)).not.toContain(token);
			const seconds = await owner.query<{ seconds: number }>(
				`SELECT extract(epoch FROM token_expires_at - now()) AS seconds FROM auth_handoff WHERE id = $1`,
				[begun.id],
			);
			expect(Number(seconds.rows[0]?.seconds)).toBeLessThanOrEqual(60);
			expect(Number(seconds.rows[0]?.seconds)).toBeGreaterThan(50);
			// The request can no longer start another sign-in.
			expect((await call(`${PLATFORM_ORIGIN}/api/careeros/handoff/request/${begun.id}`)).status).toBe(404);

			// Redeem on the organization host, with the cookie only that browser holds.
			const redeemed = await redeem(orgs.a, { request, token }, begun.verifier);
			expect(redeemed.status).toBe(200);
			expect(await redeemed.json()).toEqual({ returnTo: "/resumes?x=1" });
			const lines = redeemed.headers.getSetCookie();
			const sessionCookie = lines.find((line) => /session_token=[^;]+/.test(line) && !/session_token=;/.test(line));
			expect(sessionCookie).toBeTruthy();
			expect(sessionCookie).toMatch(/HttpOnly/);
			expect(lines.join("\n")).not.toMatch(/Domain=/i); // no cookie is shared across hosts
			expect(lines.find((line) => line.startsWith("careeros_handoff="))).toMatch(/Max-Age=0/);
			expect((await row(begun.id))?.redeemed_at).not.toBeNull();

			// The session is real, belongs to the user, and has the organization active.
			const session = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(redeemed) }) });
			expect(session?.user.id).toBe(user.userId);
			expect((session?.session as { activeOrganizationId?: string } | undefined)?.activeOrganizationId).toBe(orgs.a.id);
			expect(logs).toEqual([]);
		});

		it("keeps a returnTo that is a plain path and turns every other spelling into /dashboard", async () => {
			for (const [sent, stored] of [
				["/resumes?x=1", "/resumes?x=1"],
				["//evil.example", "/dashboard"],
				["/\\evil.example", "/dashboard"],
				["https://evil.example", "/dashboard"],
				["/%2F%2Fevil.example", "/dashboard"],
				["javascript:alert(1)", "/dashboard"],
				["/a\r\nb", "/dashboard"],
				[`/${"a".repeat(600)}`, "/dashboard"],
			] as const) {
				const begun = await begin(orgs.a, { returnTo: sent });
				expect((await row(begun.id))?.return_to, sent).toBe(stored);
			}
		});
	});

	describe("replay, expiry and binding", () => {
		it("refuses a second redeem of the same token", async () => {
			const flow = await issued(orgs.a);
			expect((await redeem(orgs.a, flow, flow.verifier)).status).toBe(200);
			const again = await redeem(orgs.a, flow, flow.verifier);
			expect(again.status).toBe(400);
			expect(await again.json()).toEqual({ code: "handoff_invalid" });
			expect(again.headers.getSetCookie().some((line) => /session_token=[^;]/.test(line))).toBe(false);
		});

		it("refuses a token after its 60 seconds, with time moved in the database", async () => {
			const flow = await issued(orgs.a);
			await owner.query(
				`UPDATE auth_handoff SET token_expires_at = token_expires_at - interval '61 seconds' WHERE id = $1`,
				[flow.id],
			);
			const late = await redeem(orgs.a, flow, flow.verifier);
			expect(late.status).toBe(400);
			expect(await late.json()).toEqual({ code: "handoff_invalid" });
			expect((await row(flow.id))?.redeemed_at).toBeNull();
		});

		it("refuses organization A's token on organization B's host, and leaves it usable on A's", async () => {
			const flow = await issued(orgs.a);
			const wrong = await redeem(orgs.b, flow, flow.verifier);
			expect(wrong.status).toBe(400);
			expect(await wrong.json()).toEqual({ code: "handoff_invalid" });
			expect((await row(flow.id))?.redeemed_at).toBeNull();
			expect((await redeem(orgs.a, flow, flow.verifier)).status).toBe(200);
		});

		it("refuses a redeem from another browser: no cookie, or a different verifier (login CSRF)", async () => {
			const flow = await issued(orgs.a);
			const attacker = await begin(orgs.a);
			for (const verifier of [undefined, "", attacker.verifier, "x".repeat(43)]) {
				const response = await redeem(orgs.a, flow, verifier);
				expect(response.status, String(verifier)).toBe(400);
				expect(await response.json()).toEqual({ code: "handoff_invalid" });
			}
			expect((await row(flow.id))?.redeemed_at).toBeNull();
			expect((await redeem(orgs.a, flow, flow.verifier)).status).toBe(200);
		});

		it("refuses a token from request X used with request Y", async () => {
			const x = await issued(orgs.a);
			const y = await issued(orgs.a);
			for (const [request, token, verifier] of [
				[y.id, x.token, y.verifier],
				[x.id, x.token, y.verifier],
				[y.id, y.token, x.verifier],
				[x.id, y.token, x.verifier],
			] as const) {
				const response = await redeem(orgs.a, { request, token }, verifier);
				expect(response.status).toBe(400);
			}
			expect((await redeem(orgs.a, x, x.verifier)).status).toBe(200);
			expect((await redeem(orgs.a, y, y.verifier)).status).toBe(200);
		});

		it("refuses malformed input without touching the database", async () => {
			const flow = await issued(orgs.a);
			for (const body of [{}, { request: flow.id }, { token: flow.token }, { request: 1, token: 2 }, []]) {
				expect((await redeem(orgs.a, body as Record<string, unknown>, flow.verifier)).status).toBe(400);
			}
			expect((await row(flow.id))?.redeemed_at).toBeNull();
		});

		it("never reuses a session cookie the browser already holds (fixation)", async () => {
			const flow = await issued(orgs.a);
			const planted = "planted-session-token.signature";
			const response = await redeem(orgs.a, flow, flow.verifier, {
				cookie: `careeros_handoff=${flow.verifier}; better-auth.session_token=${planted}`,
			});
			expect(response.status).toBe(200);
			const set = response.headers.getSetCookie().join("\n");
			expect(set).not.toContain(planted);
			const fresh = cookieHeader(response);
			expect(fresh).toMatch(/session_token=/);
			const session = await auth.api.getSession({ headers: new Headers({ cookie: fresh }) });
			expect(session?.user.id).toBe(flow.user.userId);
		});
	});

	describe("the issue step", () => {
		it("does not issue for an expired request", async () => {
			const begun = await begin(orgs.a);
			await owner.query(`UPDATE auth_handoff SET expires_at = now() - interval '1 second' WHERE id = $1`, [begun.id]);
			const user = await platformSession("late");
			await addMember(orgs.a.id, user.userId);
			const response = await issue(begun.id, user.cookie);
			expect(response.status).toBe(302);
			expect(response.headers.get("location")).toBe("/auth/error?error=handoff_failed");
			expect((await row(begun.id))?.token_hash).toBeNull();
			expect((await call(`${PLATFORM_ORIGIN}/api/careeros/handoff/request/${begun.id}`)).status).toBe(404);
		});

		it("does not issue twice for the same request", async () => {
			const flow = await issued(orgs.a);
			const first = (await row(flow.id))?.token_hash;
			const second = await issue(flow.id, flow.user.cookie);
			expect(second.headers.get("location")).toBe("/auth/error?error=handoff_failed");
			expect((await row(flow.id))?.token_hash).toBe(first);
			expect((await redeem(orgs.a, flow, flow.verifier)).status).toBe(200);
		});

		it("needs a platform session, and not a guest's", async () => {
			const begun = await begin(orgs.a);
			const anonymous = await issue(begun.id);
			expect(anonymous.headers.get("location")).toBe("/auth/error?error=handoff_failed");
			const guest = await auth.handler(
				new Request(`${PLATFORM_ORIGIN}/api/auth/sign-in/anonymous`, {
					method: "POST",
					headers: { host: PLATFORM, origin: PLATFORM_ORIGIN, "content-type": "application/json" },
					body: "{}",
				}),
			);
			if (guest.status === 200) {
				const response = await issue(begun.id, cookieHeader(guest));
				expect(response.headers.get("location")).toBe("/auth/error?error=handoff_failed");
			}
			expect((await row(begun.id))?.token_hash).toBeNull();
		});

		it("sends a non-member of an invite-only organization to the access page, with no token", async () => {
			const begun = await begin(orgs.closed);
			await pause();
			const user = await platformSession("outsider");
			const response = await issue(begun.id, user.cookie);
			expect(response.status).toBe(302);
			expect(response.headers.get("location")).toBe(`${originOf(orgs.closed)}/auth/organization-access`);
			expect((await row(begun.id))?.token_hash).toBeNull();
			const members = await owner.query(`SELECT 1 FROM member WHERE organization_id = $1 AND user_id = $2`, [
				orgs.closed.id,
				user.userId,
			]);
			expect(members.rowCount).toBe(0);
			// The session this flow created is ended here too.
			expect((await owner.query(`SELECT 1 FROM session WHERE user_id = $1`, [user.userId])).rowCount).toBe(0);
		});

		it("lets a non-member join an organization with open signup and issues a token", async () => {
			const begun = await begin(orgs.open);
			await pause();
			const user = await platformSession("joiner");
			const response = await issue(begun.id, user.cookie);
			expect(fragmentOf(response).token).not.toBe("");
			const members = await owner.query<{ role: string }>(
				`SELECT role FROM member WHERE organization_id = $1 AND user_id = $2`,
				[orgs.open.id, user.userId],
			);
			expect(members.rows).toEqual([{ role: "member" }]);
		});

		it("revokes only the session the flow created: one the user already had survives", async () => {
			const user = await platformSession("veteran");
			await addMember(orgs.a.id, user.userId);
			await pause();
			const begun = await begin(orgs.a); // after the user's session
			const response = await issue(begun.id, user.cookie);
			expect(fragmentOf(response).token).not.toBe("");
			expect((await owner.query(`SELECT 1 FROM session WHERE user_id = $1`, [user.userId])).rowCount).toBe(1);
			expect(response.headers.getSetCookie().some((line) => /session_token=;/.test(line))).toBe(false);
			// And the cookie still works on the platform host.
			const still = await auth.api.getSession({ headers: new Headers({ cookie: user.cookie }) });
			expect(still?.user.id).toBe(user.userId);
		});

		it("refuses when the organization host no longer resolves to the request's organization", async () => {
			const begun = await begin(orgs.b);
			await owner.query(`UPDATE auth_handoff SET organization_id = $2 WHERE id = $1`, [begun.id, orgs.a.id]);
			const user = await platformSession("mismatch");
			await addMember(orgs.a.id, user.userId);
			const response = await issue(begun.id, user.cookie);
			expect(response.headers.get("location")).toBe("/auth/error?error=handoff_failed");
			expect((await row(begun.id))?.token_hash).toBeNull();
		});

		it("is not served on an organization host", async () => {
			const response = await call(`${originOf(orgs.a)}/api/careeros/handoff/issue?request=${"a".repeat(22)}`);
			expect(response.status).toBe(404);
			expect((await call(`${originOf(orgs.a)}/api/careeros/handoff/request/${"a".repeat(22)}`)).status).toBe(404);
		});
	});

	describe("begin", () => {
		it("takes the organization and origin from the host, never from a header or the body", async () => {
			const begun = await begin(
				orgs.a,
				{ targetOrigin: originOf(orgs.b), organizationId: orgs.b.id, host: hostOf(orgs.b) },
				{ "x-forwarded-host": hostOf(orgs.b), "x-forwarded-proto": "https", forwarded: `host=${hostOf(orgs.b)}` },
			);
			expect(begun.response.status).toBe(200);
			expect(await row(begun.id)).toMatchObject({ organization_id: orgs.a.id, target_origin: originOf(orgs.a) });
		});

		it("requires the request origin to be the host's own", async () => {
			for (const origin of [originOf(orgs.b), "https://evil.example", PLATFORM_ORIGIN, "null"]) {
				const response = await begin(orgs.a, {}, { origin });
				expect(response.response.status, origin).toBe(403);
			}
			const before = Number((await owner.query(`SELECT count(*)::int AS n FROM auth_handoff`)).rows[0]?.n);
			const none = await call(`${originOf(orgs.a)}/api/careeros/handoff/begin`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: "google" }),
			});
			expect(none.status).toBe(403);
			expect(Number((await owner.query(`SELECT count(*)::int AS n FROM auth_handoff`)).rows[0]?.n)).toBe(before);
		});

		it("requires the redeem origin to be the host's own", async () => {
			const flow = await issued(orgs.a);
			for (const origin of [originOf(orgs.b), "https://evil.example", PLATFORM_ORIGIN]) {
				expect((await redeem(orgs.a, flow, flow.verifier, { origin })).status, origin).toBe(403);
			}
			expect((await row(flow.id))?.redeemed_at).toBeNull();
		});

		it("is only for organization hosts, with an enabled social or OIDC provider", async () => {
			const platform = await call(`${PLATFORM_ORIGIN}/api/careeros/handoff/begin`, {
				method: "POST",
				headers: { origin: PLATFORM_ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ provider: "google" }),
			});
			expect(platform.status).toBe(404);
			for (const provider of ["credential", "passkey", "github", "", 7, undefined]) {
				const response = await begin(orgs.a, { provider });
				expect(response.response.status, String(provider)).toBe(400);
			}
			const unknownHost = await call("http://nobody.orgs.test/api/careeros/handoff/begin", {
				method: "POST",
				headers: { origin: "http://nobody.orgs.test" },
				body: "{}",
			});
			expect(unknownHost.status).toBe(404);
		});
	});

	describe("the platform page's call into Better Auth", () => {
		it("accepts the relative issue URL as callbackURL and refuses a foreign one, with origin checks on", async () => {
			const context = await auth.$context;
			const wasSkipping = context.skipOriginCheck;
			context.skipOriginCheck = false;
			try {
				const begun = await begin(orgs.a);
				const start = (callbackURL: string) =>
					auth.handler(
						new Request(`${PLATFORM_ORIGIN}/api/auth/sign-in/social`, {
							method: "POST",
							headers: { host: PLATFORM, origin: PLATFORM_ORIGIN, "content-type": "application/json" },
							body: JSON.stringify({ provider: "google", callbackURL }),
						}),
					);
				const ok = await start(`/api/careeros/handoff/issue?request=${begun.id}`);
				expect(ok.status).toBe(200);
				expect(new URL(String((await ok.json()).url)).hostname).toBe("accounts.google.com");
				for (const foreign of ["https://evil.example/x", "//evil.example/x", `${originOf(orgs.a)}/api/x`]) {
					const refused = await start(foreign);
					expect(refused.status, foreign).toBe(403);
				}
			} finally {
				context.skipOriginCheck = wasSkipping;
			}
		});
	});

	describe("secrets and cleanup", () => {
		it("logs request ids and outcomes, never a token, a verifier or a handoff URL", async () => {
			const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
				vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args)),
			);
			const flow = await issued(orgs.a);
			await redeem(orgs.a, flow, flow.verifier);
			await redeem(orgs.a, flow, flow.verifier);
			// Everything any code logged during the flow, and then the handoff's own lines.
			const everything = JSON.stringify(logs);
			const text = JSON.stringify(logs.filter((args) => String(args[0]).startsWith("[handoff]")));
			expect(text).toContain(flow.id);
			expect(text).toContain("outcome=");
			for (const secret of [flow.token, flow.verifier]) expect(everything, secret).not.toContain(secret);
			for (const fragment of ["/auth/handoff/redeem", "token=", "#"]) expect(text, fragment).not.toContain(fragment);
			for (const spy of spies) spy.mockRestore();
		});

		it("deletes handoffs that expired more than an hour ago, and keeps newer ones", async () => {
			const old = await begin(orgs.a);
			const recent = await begin(orgs.a);
			const live = await begin(orgs.a);
			await owner.query(`UPDATE auth_handoff SET expires_at = now() - interval '61 minutes' WHERE id = $1`, [old.id]);
			await owner.query(`UPDATE auth_handoff SET expires_at = now() - interval '59 minutes' WHERE id = $1`, [
				recent.id,
			]);
			expect(await service.purgeExpiredHandoffs()).toBeGreaterThanOrEqual(1);
			expect(await row(old.id)).toBeUndefined();
			expect(await row(recent.id)).toBeDefined();
			expect(await row(live.id)).toBeDefined();
		});
	});
});
