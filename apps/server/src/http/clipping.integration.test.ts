import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";

// P5-T03: clipping a job, end to end, against a database of its own (every migration applied) with the real Better Auth
// configuration, the real host resolver and the real Hono app, as the `careeros_app` role. The platform model is a stubbed
// network call: no test calls the real Claude API. Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

vi.unmock("@careeros/tenancy");
vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

const PASSWORD = "correct-horse-battery";
const PLATFORM = "localhost:3000";
const PLATFORM_ORIGIN = `http://${PLATFORM}`;
const CLIENT_ID = "careeros-job-clipper";
const CHROME =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe.skipIf(!configured)("Clipping a job", () => {
	const run = randomUUID().slice(0, 8);
	const orgs = {
		a: { id: `cla-${run}`, slug: `cla-${run}`, domain: `jobs-a-${run}.example.test` },
		b: { id: `clb-${run}`, slug: `clb-${run}`, domain: `jobs-b-${run}.example.test` },
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
		return { userId: row.rows[0]?.id ?? "", cookie: cookieHeader(response) };
	};
	const member = async (org: { id: string }, label = "member") => {
		const user = await account(label);
		await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
			`m-${randomUUID()}`,
			org.id,
			user.userId,
		]);
		return user;
	};

	const authCall = (origin: string, path: string, init: RequestInit = {}) =>
		call(`${origin}/api/auth${path}`, {
			...init,
			headers: { origin, "content-type": "application/json", "user-agent": CHROME, ...(init.headers as object) },
		});
	/** A clipper token for `user` on `origin` (the organization's subdomain or custom domain): request, approve, redeem. */
	const signIn = async (origin: string, user: { userId: string; cookie: string }) => {
		const code = (await json(
			await authCall(origin, "/device/code", { method: "POST", body: JSON.stringify({ client_id: CLIENT_ID }) }),
		)) as { device_code: string; user_code: string };
		expect(
			(await authCall(origin, `/device?user_code=${code.user_code}`, { headers: { cookie: user.cookie } })).status,
		).toBe(200);
		expect(
			(
				await authCall(origin, "/device/approve", {
					method: "POST",
					body: JSON.stringify({ userCode: code.user_code }),
					headers: { cookie: user.cookie },
				})
			).status,
		).toBe(200);
		await owner.query(`UPDATE device_code SET last_polled_at = now() - interval '10 seconds' WHERE device_code = $1`, [
			code.device_code,
		]);
		const redeemed = await authCall(origin, "/device/clipper/token", {
			method: "POST",
			body: JSON.stringify({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: code.device_code,
				client_id: CLIENT_ID,
			}),
		});
		expect(redeemed.status).toBe(200);
		return String((await json(redeemed)).access_token);
	};

	const api = (origin: string, path: string, token: string, init: RequestInit = {}) =>
		call(`${origin}/api/openapi${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${token}`,
				origin,
				"content-type": "application/json",
				...(init.headers as object),
			},
		});
	const save = (origin: string, token: string, body: Record<string, unknown>) =>
		api(origin, "/applications", token, { method: "POST", body: JSON.stringify(body) });
	const findByUrl = async (origin: string, token: string, url: string) =>
		api(origin, `/clipper/find-by-url?url=${encodeURIComponent(url)}`, token);
	const applicationRow = async (id: string) =>
		(await owner.query<Record<string, unknown>>(`SELECT * FROM application WHERE id = $1`, [id])).rows[0];
	const usageRows = async (orgId: string) =>
		(
			await owner.query<Record<string, unknown>>(`SELECT * FROM ai_usage WHERE organization_id = $1 ORDER BY id`, [
				orgId,
			])
		).rows;
	const setPlan = (orgId: string, plan: string | null, status: string | null) =>
		owner.query(`SELECT careeros_set_org_plan($1, $2, $3, NULL, 'test fixture')`, [orgId, plan, status]);

	// The platform model is one stubbed network call; every request to the Anthropic host is counted and answered here.
	const modelCalls: { url: string; body: string }[] = [];
	let modelAnswer = "";
	const realFetch = globalThis.fetch;
	const stubModel = (answer: unknown) => {
		modelAnswer = typeof answer === "string" ? answer : JSON.stringify(answer);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!url.startsWith("https://api.anthropic.com/")) return await realFetch(input, init);
			modelCalls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
			return new Response(
				JSON.stringify({
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: "claude-haiku-5-5",
					content: [{ type: "text", text: modelAnswer }],
					stop_reason: "end_turn",
					stop_sequence: null,
					usage: { input_tokens: 1200, output_tokens: 300 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
	};

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("clipping_t03");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.ORG_HOST_PATTERN = "{slug}.orgs.test";
		process.env.APP_URL = PLATFORM_ORIGIN;
		process.env.TRUST_FORWARDED_HOST = "false";
		process.env.CF_SAAS_API_TOKEN = "cf-integration-token-NEVER-LOG-ME";
		process.env.CF_ZONE_ID = "0123456789abcdef0123456789abcdef";
		process.env.CF_SAAS_CNAME_TARGET = "saas.customers.example.test";
		// A placeholder platform key: it is never sent anywhere, the network call is stubbed above.
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-placeholder-not-a-real-key";
		process.env.FLAG_ALLOW_UNSAFE_AI_BASE_URL = "true";
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
			await setPlan(org.id, "pro", null);
		}
		({ auth } = await import("@reactive-resume/auth/config"));
		const { createApp } = await import("./app");
		hono = createApp({ serveStatic: false, trustedClient: () => "203.0.113.9" });
	}, 180_000);

	afterEach(() => {
		vi.unstubAllGlobals();
		modelCalls.length = 0;
	});

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	const posting = {
		company: "Aurora Analytics",
		role: "Senior Backend Engineer",
		location: "Nairobi, KE",
		salary: "KES 250,000 - 400,000 per month",
		sourceUrl: "https://careers.example.test/jobs/senior-backend-engineer",
		jobDescription: "<p>Build <b>reliable</b> services.</p><script>alert(1)</script><ul><li>TypeScript</li></ul>",
		status: "saved",
		source: "clipper",
	};

	describe("saving a clip", () => {
		it("saves to the token's own organization and member, with the marker and a plain-text description", async () => {
			const user = await member(orgs.a);
			const token = await signIn(originOf(orgs.a), user);
			const response = await save(originOf(orgs.a), token, posting);
			expect(response.status).toBe(200);
			const id = (await response.json()) as string;
			const row = await applicationRow(id);
			expect(row).toMatchObject({
				organization_id: orgs.a.id,
				user_id: user.userId,
				company: "Aurora Analytics",
				role: "Senior Backend Engineer",
				location: "Nairobi, KE",
				status: "saved",
				source: "clipper",
				source_url: "https://careers.example.test/jobs/senior-backend-engineer",
			});
			const description = String(row?.job_description);
			expect(description).toContain("Build reliable services.");
			expect(description).toContain("TypeScript");
			expect(description).not.toMatch(/<|alert\(/);
		});

		it("also saves on the organization's custom domain, to the same organization", async () => {
			const user = await member(orgs.a);
			const token = await signIn(domainOrigin(orgs.a), user);
			const response = await save(domainOrigin(orgs.a), token, { ...posting, role: "Platform Engineer" });
			expect(response.status).toBe(200);
			expect(await applicationRow((await response.json()) as string)).toMatchObject({
				organization_id: orgs.a.id,
				user_id: user.userId,
				role: "Platform Engineer",
			});
		});

		it("drops everything a clip does not carry, whatever the request says", async () => {
			const user = await member(orgs.a);
			const token = await signIn(originOf(orgs.a), user);
			const response = await save(originOf(orgs.a), token, {
				...posting,
				status: "offer",
				notes: "smuggled",
				tags: ["x"],
				resumeId: "resume-from-elsewhere",
			});
			expect(response.status).toBe(200);
			const row = await applicationRow((await response.json()) as string);
			expect(row).toMatchObject({ status: "saved", source: "clipper", resume_id: null });
			expect(row?.tags).toEqual([]);
		});

		it("refuses the same token on another organization's address", async () => {
			const user = await member(orgs.a);
			const token = await signIn(originOf(orgs.a), user);
			const before = (
				await owner.query(`SELECT count(*)::int AS n FROM application WHERE organization_id = $1`, [orgs.b.id])
			).rows[0];
			expect((await save(originOf(orgs.b), token, posting)).status).toBe(401);
			expect((await save(domainOrigin(orgs.b), token, posting)).status).toBe(401);
			expect((await findByUrl(originOf(orgs.b), token, posting.sourceUrl)).status).toBe(401);
			const after = (
				await owner.query(`SELECT count(*)::int AS n FROM application WHERE organization_id = $1`, [orgs.b.id])
			).rows[0];
			expect(after).toEqual(before);
		});

		it("refuses a save from a suspended organization", async () => {
			const user = await member(orgs.b);
			const token = await signIn(originOf(orgs.b), user);
			await setPlan(orgs.b.id, null, "suspended");
			try {
				const response = await save(originOf(orgs.b), token, { ...posting, role: "Suspended Role" });
				expect(response.status).toBe(403);
				expect(await json(response)).toMatchObject({ data: { code: "ORG_SUSPENDED" } });
				const rows = await owner.query(
					`SELECT 1 FROM application WHERE organization_id = $1 AND role = 'Suspended Role'`,
					[orgs.b.id],
				);
				expect(rows.rowCount).toBe(0);
			} finally {
				await setPlan(orgs.b.id, "pro", "active");
			}
		});
	});

	describe("the duplicate check", () => {
		it("finds the member's own application for the same address, however it was reached", async () => {
			const user = await member(orgs.a);
			const token = await signIn(originOf(orgs.a), user);
			const id = (await (await save(originOf(orgs.a), token, posting)).json()) as string;
			const found = await findByUrl(
				originOf(orgs.a),
				token,
				"http://www.careers.example.test/jobs/senior-backend-engineer/?utm_source=x#apply",
			);
			expect(found.status).toBe(200);
			expect(await json(found)).toEqual({ match: { id, title: "Senior Backend Engineer" } });
			expect(await json(await findByUrl(originOf(orgs.a), token, "https://careers.example.test/jobs/other"))).toEqual({
				match: null,
			});
		});

		it("never returns another member's application in the same organization", async () => {
			const first = await member(orgs.a);
			const second = await member(orgs.a);
			const url = `https://careers.example.test/jobs/private-${run}`;
			const firstToken = await signIn(originOf(orgs.a), first);
			const secondToken = await signIn(originOf(orgs.a), second);
			await save(originOf(orgs.a), firstToken, { ...posting, sourceUrl: url });
			expect((await json(await findByUrl(originOf(orgs.a), firstToken, url))).match).not.toBeNull();
			expect(await json(await findByUrl(originOf(orgs.a), secondToken, url))).toEqual({ match: null });
		});

		it("never returns another organization's application, even for a member of both", async () => {
			const both = await member(orgs.a);
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
				`m-${randomUUID()}`,
				orgs.b.id,
				both.userId,
			]);
			const url = `https://careers.example.test/jobs/org-a-only-${run}`;
			const tokenA = await signIn(originOf(orgs.a), both);
			const tokenB = await signIn(originOf(orgs.b), both);
			await save(originOf(orgs.a), tokenA, { ...posting, sourceUrl: url });
			expect((await json(await findByUrl(originOf(orgs.a), tokenA, url))).match).not.toBeNull();
			expect(await json(await findByUrl(originOf(orgs.b), tokenB, url))).toEqual({ match: null });
			const outsider = await member(orgs.b);
			const outsiderToken = await signIn(originOf(orgs.b), outsider);
			expect(await json(await findByUrl(originOf(orgs.b), outsiderToken, url))).toEqual({ match: null });
		});

		it("answers only an id and a title", async () => {
			const user = await member(orgs.a);
			const token = await signIn(originOf(orgs.a), user);
			await save(originOf(orgs.a), token, { ...posting, sourceUrl: `https://careers.example.test/jobs/shape-${run}` });
			const body = await json(
				await findByUrl(originOf(orgs.a), token, `https://careers.example.test/jobs/shape-${run}`),
			);
			expect(Object.keys(body.match as object).sort()).toEqual(["id", "title"]);
		});
	});

	describe("Tidy with AI", () => {
		const fields = {
			title: "Engineer",
			company: "Aurora",
			location: "",
			salary: "",
			description: "Home | Jobs | Cookies\nBuild services.\nShare on social",
		};
		const tidied = { ...fields, title: "Engineer", description: "Build services." };
		const seedCredits = (orgId: string, userId: string, credits: number) =>
			owner.query(
				`INSERT INTO ai_usage (organization_id, user_id, source, feature, provider, model, credits)
				 VALUES ($1, $2, 'platform', 'resume.improve', 'anthropic', 'claude-haiku-5-5', $3)`,
				[orgId, userId, credits],
			);

		it("is offered by whoami only while the plan includes platform AI and credits are left", async () => {
			const user = await member(orgs.a);
			const token = await signIn(originOf(orgs.a), user);
			expect((await json(await api(originOf(orgs.a), "/clipper/whoami", token))).tidyAvailable).toBe(true);
			await seedCredits(orgs.a.id, user.userId, 1_000_000);
			try {
				expect((await json(await api(originOf(orgs.a), "/clipper/whoami", token))).tidyAvailable).toBe(false);
			} finally {
				await owner.query(`DELETE FROM ai_usage WHERE organization_id = $1`, [orgs.a.id]);
			}
		});

		it("makes exactly one metered model call and writes one ai_usage row", async () => {
			const user = await member(orgs.a);
			const token = await signIn(originOf(orgs.a), user);
			await owner.query(`DELETE FROM ai_usage WHERE organization_id = $1`, [orgs.a.id]);
			stubModel(tidied);
			const response = await api(originOf(orgs.a), "/clipper/cleanup", token, {
				method: "POST",
				body: JSON.stringify(fields),
			});
			expect(response.status).toBe(200);
			expect(await json(response)).toEqual({ tidied: true, fields: tidied });
			expect(modelCalls).toHaveLength(1);
			// The page text reaches the model as marked data, never as part of the instructions.
			expect(modelCalls[0]?.body).toContain("Home | Jobs | Cookies");
			const rows = await usageRows(orgs.a.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				feature: "clipper.cleanup",
				source: "platform",
				user_id: user.userId,
				provider: "anthropic",
				input_tokens: 1200,
				output_tokens: 300,
			});
		});

		it("changes nothing when the answer is not valid, and still counts the one call", async () => {
			const user = await member(orgs.a);
			const token = await signIn(originOf(orgs.a), user);
			await owner.query(`DELETE FROM ai_usage WHERE organization_id = $1`, [orgs.a.id]);
			stubModel({ title: "", company: "x" });
			const response = await api(originOf(orgs.a), "/clipper/cleanup", token, {
				method: "POST",
				body: JSON.stringify(fields),
			});
			expect(response.status).toBe(200);
			expect(await json(response)).toEqual({ tidied: false, fields });
			expect(modelCalls).toHaveLength(1);
		});

		it("makes no model call when the allowance is used up", async () => {
			const user = await member(orgs.a);
			const token = await signIn(originOf(orgs.a), user);
			await seedCredits(orgs.a.id, user.userId, 1_000_000);
			stubModel(tidied);
			try {
				const response = await api(originOf(orgs.a), "/clipper/cleanup", token, {
					method: "POST",
					body: JSON.stringify(fields),
				});
				expect(response.status).toBe(402);
				expect(await json(response)).toMatchObject({ code: "AI_QUOTA_EXCEEDED" });
				expect(modelCalls).toHaveLength(0);
			} finally {
				await owner.query(`DELETE FROM ai_usage WHERE organization_id = $1`, [orgs.a.id]);
			}
		});

		it("is refused on another organization's address", async () => {
			const user = await member(orgs.a);
			const token = await signIn(originOf(orgs.a), user);
			stubModel(tidied);
			const response = await api(originOf(orgs.b), "/clipper/cleanup", token, {
				method: "POST",
				body: JSON.stringify(fields),
			});
			expect(response.status).toBe(401);
			expect(modelCalls).toHaveLength(0);
		});
	});
});
