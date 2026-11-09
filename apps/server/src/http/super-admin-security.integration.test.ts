import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import {
	EXPECTED_CLIPPER_ON_ORG_HOST,
	EXPECTED_OFF_PLATFORM_REFUSAL,
	EXPECTED_REFUSAL,
	NON_STAFF_CALLERS,
	rpcPath,
	SUPER_ADMIN_PROCEDURES,
	type NonStaffCaller,
	type Refusal,
	type SuperAdminSeed,
} from "@careeros/testing/super-admin-inventory";
import { Pool } from "pg";

// P3-Q03: the Super Admin console over real HTTP. Real Hono app, real Better Auth, real host resolver, real oRPC router
// and row-level security as the `careeros_app` role, on a database of its own with every migration applied. Skipped only
// when the CAREEROS_TEST_* variables are absent; CI sets them (and the skipped-suite guard fails CI if it skips there).
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

// The shared setup file replaces the tenancy module; this test needs the real host resolver and organization scope.
vi.unmock("@careeros/tenancy");
vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

const PASSWORD = "correct-horse-battery";
const PLATFORM = "localhost:3000";
const PLATFORM_ORIGIN = `http://${PLATFORM}`;
const CLIENT_ID = "careeros-job-clipper";

type Cred = { cookie?: string; apiKey?: string; bearer?: string };
type Reply = { status: number; code: string | undefined; dataCode: string | undefined; text: string; body: unknown };

describe.skipIf(!configured)("Super Admin security over HTTP", () => {
	const run = randomUUID().slice(0, 8);
	const orgs = {
		a: { id: `sa-a-${run}`, slug: `sa-a-${run}`, name: `Acme ${run}`, domain: `jobs-sa-a-${run}.example.test` },
		b: { id: `sa-b-${run}`, slug: `sa-b-${run}`, name: `Beta ${run}`, domain: `jobs-sa-b-${run}.example.test` },
	};
	const hostOf = (org: { slug: string }) => `${org.slug}.orgs.test`;
	const originOf = (org: { slug: string }) => `http://${hostOf(org)}`;
	const domainOrigin = (org: { domain: string }) => `http://${org.domain}`;

	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let auth: typeof import("@reactive-resume/auth/config").auth;
	let platformAdmin: typeof import("@careeros/platform-admin");
	let policy: typeof import("@careeros/platform-admin/policy");
	let hono: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

	const cookieHeader = (response: Response) =>
		response.headers
			.getSetCookie()
			.map((line) => line.split(";", 1)[0])
			.filter((pair) => !pair?.endsWith("="))
			.join("; ");
	const ownerRows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
		(await owner.query<T>(sql, params)).rows;

	type Account = { id: string; email: string; cookie: string };
	const account = async (label: string): Promise<Account> => {
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
		const row = await ownerRows<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
		return { id: row[0]?.id ?? "", email, cookie: cookieHeader(response) };
	};
	const addMember = (organizationId: string, userId: string, role: string) =>
		owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
			`m-${randomUUID()}`,
			organizationId,
			userId,
			role,
		]);
	const setRole = (userId: string, role: string, twoFactor: boolean, banned = false) =>
		owner.query(`UPDATE "user" SET role = $2, two_factor_enabled = $3, banned = $4 WHERE id = $1`, [
			userId,
			role,
			twoFactor,
			banned,
		]);
	const makeOrg = async (org: { id: string; slug: string; name: string }, plan = "starter") => {
		await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [org.id, org.name, org.slug]);
		await owner.query(`SELECT careeros_set_org_plan($1, $2, NULL, NULL, 'test fixture')`, [org.id, plan]);
	};

	/** One call on the RPC adapter, exactly as a browser or a script makes it. */
	const rpc = async (origin: string, procedure: string, input: unknown, cred: Cred = {}): Promise<Reply> => {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (cred.cookie) {
			headers.cookie = cred.cookie;
			headers.origin = origin;
		}
		if (cred.apiKey) headers["x-api-key"] = cred.apiKey;
		if (cred.bearer) {
			headers.authorization = `Bearer ${cred.bearer}`;
			headers.origin = origin;
		}
		const response = await hono.request(`${origin}${rpcPath(procedure)}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ json: input }),
		});
		const text = await response.text();
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}
		const error = (body as { json?: { code?: string; data?: { code?: string } } } | undefined)?.json;
		return { status: response.status, code: error?.code, dataCode: error?.data?.code, text, body };
	};
	const expectRefusal = (reply: Reply, expected: Refusal, label: string) => {
		expect({ status: reply.status, code: reply.code, dataCode: reply.dataCode }, label).toEqual({
			status: expected.status,
			code: expected.code,
			dataCode: expected.dataCode,
		});
	};

	/** What a refused call must leave untouched: every table the console writes, and the organization rows. */
	const snapshot = async () =>
		(
			await ownerRows<Record<string, string>>(`SELECT
				(SELECT count(*) FROM audit_log)::text AS audit,
				(SELECT count(*) FROM announcement)::text AS announcements,
				(SELECT count(*) FROM impersonation)::text AS impersonations,
				(SELECT md5(string_agg(o::text, '|' ORDER BY o.id)) FROM organization o) AS organizations,
				(SELECT md5(coalesce(string_agg(s::text, '|' ORDER BY s.organization_id), '')) FROM subscription s) AS subscriptions`)
		).at(0) ?? ({} as Record<string, string>);

	// The device flow of the Job Clipper, to get a real clipper token for a platform admin who belongs to an organization.
	const clipperToken = async (org: { slug: string }, who: Account) => {
		const origin = originOf(org);
		const call = (path: string, body: unknown, withCookie = true) =>
			hono.request(`${origin}/api/auth${path}`, {
				method: "POST",
				headers: {
					origin,
					"content-type": "application/json",
					"user-agent": "Mozilla/5.0 Chrome/130.0.0.0",
					...(withCookie ? { cookie: who.cookie } : {}),
				},
				body: JSON.stringify(body),
			});
		const code = (await (await call("/device/code", { client_id: CLIENT_ID }, false)).json()) as {
			device_code: string;
			user_code: string;
		};
		await hono.request(`${origin}/api/auth/device?user_code=${code.user_code}`, {
			headers: { origin, cookie: who.cookie },
		});
		expect((await call("/device/approve", { userCode: code.user_code })).status).toBe(200);
		const redeemed = await call(
			"/device/clipper/token",
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: code.device_code,
				client_id: CLIENT_ID,
			},
			false,
		);
		expect(redeemed.status).toBe(200);
		return String(((await redeemed.json()) as { access_token: string }).access_token);
	};

	let people: {
		admin: Account;
		member: Account;
		orgAdmin: Account;
		orgOwner: Account;
		banned: Account;
		noTwoFactor: Account;
		plain: Account;
		bOwner: Account;
	};
	let seed: SuperAdminSeed;
	let adminApiKey: string;
	let adminClipper: string;

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("sa_security_q03");
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
			await makeOrg(org);
			await owner.query(
				`INSERT INTO organization_domain (id, organization_id, hostname, status, verification_token) VALUES ($1, $2, $3, 'active', 'token')`,
				[`dom-${org.id}`, org.id, org.domain],
			);
		}
		({ auth } = await import("@reactive-resume/auth/config"));
		platformAdmin = await import("@careeros/platform-admin");
		policy = await import("@careeros/platform-admin/policy");
		const { createApp } = await import("./app");
		hono = createApp({ serveStatic: false, trustedClient: () => "203.0.113.9" });

		people = {
			admin: await account("admin"),
			member: await account("member"),
			orgAdmin: await account("orgadmin"),
			orgOwner: await account("orgowner"),
			banned: await account("banned"),
			noTwoFactor: await account("notwofactor"),
			plain: await account("plain"),
			bOwner: await account("bowner"),
		};
		await setRole(people.admin.id, "admin", true);
		await setRole(people.banned.id, "admin", true, true);
		await setRole(people.noTwoFactor.id, "admin", false);
		await addMember(orgs.a.id, people.member.id, "member");
		await addMember(orgs.a.id, people.orgAdmin.id, "admin");
		await addMember(orgs.a.id, people.orgOwner.id, "owner");
		await addMember(orgs.b.id, people.bOwner.id, "owner");
		// The platform admin also belongs to an organization, so that an API key and a clipper token exist for them.
		await addMember(orgs.b.id, people.admin.id, "member");
		adminApiKey = (await auth.api.createApiKey({ body: { userId: people.admin.id } })).key;
		adminClipper = await clipperToken(orgs.b, people.admin);
		const announcementId = randomUUID();
		await owner.query(
			`INSERT INTO announcement (id, title, body, severity, starts_at, ends_at) VALUES ($1, 'Seeded', 'Seeded body', 'info', now() - interval '1 hour', now() + interval '1 hour')`,
			[announcementId],
		);
		seed = { orgId: orgs.a.id, userId: people.member.id, announcementId, planId: "starter", unique: run };
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	describe("access: every procedure refuses everyone who is not platform staff", () => {
		const credentials = (): Record<NonStaffCaller, Cred> => ({
			anonymous: {},
			member: { cookie: people.member.cookie },
			"org admin": { cookie: people.orgAdmin.cookie },
			"org owner": { cookie: people.orgOwner.cookie },
			"banned platform admin": { cookie: people.banned.cookie },
			"platform admin without 2FA": { cookie: people.noTwoFactor.cookie },
			// Real credentials of a real platform admin: neither works as a console credential.
			"clipper token": { bearer: adminClipper },
			"API key": { apiKey: adminApiKey },
		});

		it("covers every kind of caller and every procedure the router has (the table is the router's, see the unit test)", () => {
			expect(NON_STAFF_CALLERS.length).toBeGreaterThanOrEqual(8);
			expect(SUPER_ADMIN_PROCEDURES.length).toBeGreaterThanOrEqual(13);
		});

		for (const caller of NON_STAFF_CALLERS)
			it(`refuses ${caller} on every procedure, with the exact answer, and changes nothing`, async () => {
				const before = await snapshot();
				const cred = credentials()[caller];
				for (const procedure of SUPER_ADMIN_PROCEDURES) {
					const reply = await rpc(PLATFORM_ORIGIN, procedure.path, procedure.input(seed), cred);
					expectRefusal(reply, EXPECTED_REFUSAL[caller], `${caller} calling ${procedure.path}`);
					// Nothing of the console's answer reaches the caller: no organization name, no owner email.
					expect(reply.text, `${procedure.path} leaks nothing`).not.toContain(orgs.a.name);
					expect(reply.text, `${procedure.path} leaks nothing`).not.toContain(people.orgOwner.email);
				}
				expect(await snapshot(), `${caller} changed something`).toEqual(before);
			});

		it("refuses a clipper token on an organization host as well (it reaches only its allow-list)", async () => {
			const before = await snapshot();
			for (const procedure of SUPER_ADMIN_PROCEDURES) {
				const reply = await rpc(originOf(orgs.b), procedure.path, procedure.input(seed), { bearer: adminClipper });
				expectRefusal(reply, EXPECTED_CLIPPER_ON_ORG_HOST, `clipper token on org host calling ${procedure.path}`);
			}
			expect(await snapshot()).toEqual(before);
		});

		const offPlatform: [string, () => string][] = [
			["an organization host", () => originOf(orgs.a)],
			["a custom domain", () => domainOrigin(orgs.a)],
			["an organization host of another organization", () => originOf(orgs.b)],
			["an organization host that does not exist", () => `http://nobody-${run}.orgs.test`],
		];
		for (const [name, origin] of offPlatform)
			it(`refuses a real platform admin with 2FA on ${name}, on every procedure, and changes nothing`, async () => {
				const before = await snapshot();
				for (const procedure of SUPER_ADMIN_PROCEDURES) {
					const reply = await rpc(origin(), procedure.path, procedure.input(seed), { cookie: people.admin.cookie });
					// A host that no organization owns is answered by the host layer, before oRPC: the status is the same.
					if (name === "an organization host that does not exist")
						expect(reply.status, `admin on ${name} calling ${procedure.path}`).toBe(404);
					else expectRefusal(reply, EXPECTED_OFF_PLATFORM_REFUSAL, `admin on ${name} calling ${procedure.path}`);
				}
				expect(await snapshot()).toEqual(before);
			});

		it("is a real gate: the same admin, session and inputs are served on the platform host (no refusal is vacuous)", async () => {
			const served: string[] = [];
			for (const procedure of SUPER_ADMIN_PROCEDURES) {
				const reply = await rpc(PLATFORM_ORIGIN, procedure.path, procedure.input(seed), {
					cookie: people.admin.cookie,
				});
				expect(reply.status, `${procedure.path}: ${reply.text.slice(0, 200)}`).toBe(200);
				served.push(procedure.path);
			}
			expect(served).toHaveLength(SUPER_ADMIN_PROCEDURES.length);
			// Each served call wrote its audit row: no console action is possible without one.
			const actions = await ownerRows<{ action: string }>(
				`SELECT DISTINCT action FROM audit_log WHERE actor_user_id = $1 AND action LIKE 'admin.%'`,
				[people.admin.id],
			);
			expect(actions.map((row) => row.action)).toEqual(
				expect.arrayContaining([
					"admin.orgs_listed",
					"admin.org_viewed",
					"admin.org_status_set",
					"admin.org_plan_set",
					"admin.ai_overage_set",
					"admin.metrics_viewed",
					"admin.audit_viewed",
					"admin.announcements_listed",
					"admin.announcement_saved",
					"admin.announcement_ended",
					"admin.impersonation_started",
				]),
			);
			// Put the organization back for the suites below.
			await owner.query(`SELECT careeros_set_org_plan($1, 'starter', 'active', NULL, 'test fixture')`, [orgs.a.id]);
		});

		it("never serves the admin gate to a session of a user that lost the admin role mid-session", async () => {
			const worker = await account("demoted");
			await setRole(worker.id, "admin", true);
			expect((await rpc(PLATFORM_ORIGIN, "admin.orgs.list", {}, { cookie: worker.cookie })).status).toBe(200);
			await setRole(worker.id, "user", true);
			expectRefusal(
				await rpc(PLATFORM_ORIGIN, "admin.orgs.list", {}, { cookie: worker.cookie }),
				EXPECTED_REFUSAL.member,
				"demoted admin",
			);
		});

		it("does not serve the Better Auth admin endpoints over HTTP, to a real platform admin", async () => {
			for (const path of policy.DISABLED_ADMIN_AUTH_PATHS) {
				for (const method of ["GET", "POST"]) {
					const response = await hono.request(`${PLATFORM_ORIGIN}/api/auth${path}`, {
						method,
						headers: { cookie: people.admin.cookie, origin: PLATFORM_ORIGIN, "content-type": "application/json" },
						...(method === "POST" ? { body: "{}" } : {}),
					});
					expect(response.status, `${method} ${path}`).toBe(404);
				}
			}
		});
	});

	describe("impersonation", () => {
		type Support = { id: string; url: string; origin: string; cookie: string; member: Account; org: typeof orgs.a };
		const memberSession = (support: Support): Cred => ({ cookie: support.cookie });

		/** Starts a support session as the real admin and redeems it on the member's organization host. */
		const startSupport = async (target = orgs.a, memberAccount = people.member): Promise<Support> => {
			const started = await rpc(
				PLATFORM_ORIGIN,
				"admin.impersonation.start",
				{ organizationId: target.id, userId: memberAccount.id, reason: "security test: support ticket" },
				{ cookie: people.admin.cookie },
			);
			expect(started.status, started.text).toBe(200);
			const { url } = (started.body as { json: { url: string } }).json;
			const parsed = new URL(url);
			const params = new URLSearchParams(parsed.hash.slice(1));
			const response = await hono.request(`${parsed.origin}/api/careeros/impersonation/redeem`, {
				method: "POST",
				headers: { origin: parsed.origin, "content-type": "application/json" },
				body: JSON.stringify({ id: params.get("id"), token: params.get("token") }),
			});
			expect(response.status, await response.clone().text()).toBe(200);
			return {
				id: String(params.get("id")),
				url,
				origin: parsed.origin,
				cookie: cookieHeader(response),
				member: memberAccount,
				org: target,
			};
		};

		it("starts on the platform host, redeems once on the member's host only, and shows the banner data", async () => {
			const support = await startSupport();
			expect(new URL(support.url).hostname).toBe(hostOf(orgs.a));
			expect(support.url).not.toContain("?");
			const params = new URLSearchParams(new URL(support.url).hash.slice(1));

			// The link works once; the same token on the same host again is refused, as is any other host.
			for (const origin of [support.origin, originOf(orgs.b), domainOrigin(orgs.a), PLATFORM_ORIGIN]) {
				const again = await hono.request(`${origin}/api/careeros/impersonation/redeem`, {
					method: "POST",
					headers: { origin, "content-type": "application/json" },
					body: JSON.stringify({ id: support.id, token: params.get("token") }),
				});
				expect(again.status, origin).not.toBe(200);
				expect(again.headers.getSetCookie(), origin).toEqual([]);
			}

			// The banner: who, which organization, when it ends (at most 60 minutes from the start).
			const banner = await rpc(support.origin, "impersonation.current", {}, memberSession(support));
			expect(banner.status).toBe(200);
			const data = (banner.body as { json: { userName: string; organizationName: string; expiresAt: string } }).json;
			expect(data).toMatchObject({ userName: "Name member", organizationName: orgs.a.name });
			const left = new Date(data.expiresAt).getTime() - Date.now();
			expect(left).toBeGreaterThan(55 * 60_000);
			expect(left).toBeLessThanOrEqual(policy.IMPERSONATION_MAX_MS);
			await rpc(support.origin, "impersonation.end", {}, memberSession(support));
		});

		it("lasts 60 minutes at most: after the record's expiry the next request is refused, even with a live session row", async () => {
			const support = await startSupport();
			expect((await rpc(support.origin, "branding.get", {}, memberSession(support))).status).toBe(200);
			const live = await hono.request(`${support.origin}/api/auth/get-session`, {
				headers: { cookie: support.cookie, origin: support.origin },
			});
			expect(await live.json(), "get-session while the support session is live").not.toBeNull();
			const [record] = await ownerRows<{ expires_at: Date; started_at: Date }>(
				`SELECT expires_at, started_at FROM impersonation WHERE id = $1`,
				[support.id],
			);
			expect(Number(record?.expires_at.getTime()) - Number(record?.started_at.getTime())).toBe(
				policy.IMPERSONATION_MAX_MS,
			);

			// Only the support record runs out; the Better Auth session row is still valid, so the record is what refuses.
			await owner.query(`UPDATE impersonation SET expires_at = now() - interval '1 second' WHERE id = $1`, [
				support.id,
			]);
			const [session] = await ownerRows<{ live: boolean }>(
				`SELECT expires_at > now() AS live FROM session WHERE impersonated_by = $1 ORDER BY created_at DESC LIMIT 1`,
				[people.admin.id],
			);
			expect(session?.live, "the session row itself has not expired").toBe(true);
			for (const procedure of ["branding.get", "impersonation.current", "auth.getProfile"]) {
				const reply = await rpc(support.origin, procedure, {}, memberSession(support));
				expect(reply.status, `${procedure} after expiry`).toBe(401);
			}
			// The web app learns it is signed in from /api/auth/get-session: it must say "no session" too, and clear the cookie.
			const getSession = async (cookie: string) =>
				await hono.request(`${support.origin}/api/auth/get-session`, { headers: { cookie, origin: support.origin } });
			const gone = await getSession(support.cookie);
			expect(gone.status).toBe(200);
			expect(await gone.json(), "get-session after the record's expiry").toBeNull();
			expect(gone.headers.getSetCookie().join("\n")).toMatch(/session_token=;|Max-Age=0/i);
			expect(await (await getSession(people.member.cookie)).json(), "an ordinary session is unaffected").not.toBeNull();
			// A normal session of the same member is not affected.
			expect((await rpc(support.origin, "branding.get", {}, { cookie: people.member.cookie })).status).toBe(200);

			// The sweep audits the expiry in the member's organization and in the platform log, once.
			const before = await snapshot();
			expect(await platformAdmin.expireDueImpersonations()).toBeGreaterThanOrEqual(1);
			const rows = await ownerRows<{
				organization_id: string | null;
				action: string;
				metadata: { endReason?: string };
			}>(
				`SELECT organization_id, action, metadata FROM audit_log WHERE metadata ->> 'impersonationId' = $1 AND action LIKE '%ended' ORDER BY action`,
				[support.id],
			);
			expect(rows.map((row) => [row.action, row.organization_id, row.metadata.endReason])).toEqual([
				["admin.impersonation_ended", null, "expired"],
				["impersonation.ended", orgs.a.id, "expired"],
			]);
			expect((await snapshot()).audit).toBe(String(Number(before.audit) + 2));
			expect(await platformAdmin.expireDueImpersonations()).toBe(0);
		});

		it("ends when the member presses End now, audited in both places, and the session is refused afterwards", async () => {
			const support = await startSupport();
			const ended = await rpc(support.origin, "impersonation.end", {}, memberSession(support));
			expect(ended.body).toMatchObject({ json: { ended: true } });
			expect((await rpc(support.origin, "branding.get", {}, memberSession(support))).status).toBe(401);
			const rows = await ownerRows<{ organization_id: string | null; action: string }>(
				`SELECT organization_id, action FROM audit_log WHERE metadata ->> 'impersonationId' = $1 ORDER BY action`,
				[support.id],
			);
			expect(rows.map((row) => [row.action, row.organization_id])).toEqual([
				["admin.impersonation_ended", null],
				["admin.impersonation_started", null],
				["impersonation.ended", orgs.a.id],
				["impersonation.started", orgs.a.id],
			]);
		});

		it("is refused for a platform admin as the target, for a non-member, and without a reason", async () => {
			const other = await account("otheradmin");
			await setRole(other.id, "admin", true);
			await addMember(orgs.a.id, other.id, "member");
			const before = await snapshot();
			const start = (organizationId: string, userId: string, reason: string) =>
				rpc(
					PLATFORM_ORIGIN,
					"admin.impersonation.start",
					{ organizationId, userId, reason },
					{
						cookie: people.admin.cookie,
					},
				);
			const admin = await start(orgs.a.id, other.id, "security test: support ticket");
			expect({ status: admin.status, data: admin.dataCode }).toEqual({ status: 403, data: "CANNOT_IMPERSONATE_ADMIN" });
			expect((await start(orgs.b.id, people.member.id, "security test: support ticket")).status).toBe(400);
			expect((await start(orgs.a.id, people.member.id, "no")).status).toBe(400);
			// Nothing started: no record and no start row. The organization lookup that comes first is itself audited.
			const after = await snapshot();
			expect({ ...after, audit: undefined }).toEqual({ ...before, audit: undefined });
			const added = await ownerRows<{ action: string }>(`SELECT action FROM audit_log ORDER BY id DESC LIMIT $1`, [
				Number(after.audit) - Number(before.audit),
			]);
			expect(added.map((row) => row.action).filter((action) => action !== "admin.org_viewed")).toEqual([]);
		});

		it("cannot change the member's password, email, 2FA, passkeys, API keys or account, over Better Auth", async () => {
			// A verified address, so the passkey endpoints reach the support-session rule and not the "verify first" rule.
			await owner.query(`UPDATE "user" SET email_verified = true WHERE id = $1`, [people.member.id]);
			const support = await startSupport();
			const schemaResponse = await hono.request(`${PLATFORM_ORIGIN}/api/auth/open-api/generate-schema`);
			const schema = (await schemaResponse.json()) as { paths: Record<string, Record<string, unknown>> };
			const refused = Object.entries(schema.paths).filter(([path]) => policy.isAuthPathRefusedWhileImpersonating(path));
			const names = refused.map(([path]) => path);
			// The refused set really reaches the endpoints the requirement names.
			for (const needle of [
				"/change-password",
				"/change-email",
				"/two-factor/",
				"/passkey/",
				"/api-key/create",
				"/delete-user",
			])
				expect(
					names.some((path) => path.includes(needle)),
					`the schema has an endpoint for ${needle}`,
				).toBe(true);

			const sessionBefore = await ownerRows(
				`SELECT id FROM session WHERE user_id = $1 AND impersonated_by IS NOT NULL`,
				[support.member.id],
			);
			expect(sessionBefore.length).toBeGreaterThan(0);
			const credentialsBefore = await ownerRows<Record<string, unknown>>(
				`SELECT (SELECT md5(string_agg(a::text, '|' ORDER BY a.id)) FROM account a WHERE a.user_id = $1) AS accounts,
				 (SELECT count(*) FROM apikey WHERE reference_id = $1)::text AS keys,
				 (SELECT email FROM "user" WHERE id = $1) AS email,
				 (SELECT two_factor_enabled FROM "user" WHERE id = $1) AS two_factor`,
				[support.member.id],
			);
			const allowedMediaTypes = new Map<string, string[]>();
			for (const endpoint of Object.values(
				auth.api as unknown as Record<
					string,
					{ path?: string; options?: { metadata?: { allowedMediaTypes?: string[] } } }
				>,
			))
				if (endpoint.path) allowedMediaTypes.set(endpoint.path, endpoint.options?.metadata?.allowedMediaTypes ?? []);
			// /oauth2/delete-consent is not in this loop: Better Auth's global hook answers it (and revokes tokens) before the
			// support-session guard runs. It has its own test below (Q424), which fails today.
			for (const [path, methods] of refused.filter(([refusedPath]) => refusedPath !== "/oauth2/delete-consent"))
				for (const method of Object.keys(methods).filter((verb) => verb === "get" || verb === "post")) {
					// Send the content type the endpoint accepts (its own metadata), so Better Auth's body check does not
					// answer first and the support-session guard is what is exercised.
					const accepted = allowedMediaTypes.get(path) ?? [];
					const form = accepted.length > 0 && !accepted.includes("application/json");
					const response = await hono.request(`${support.origin}/api/auth${path}`, {
						method: method.toUpperCase(),
						headers: {
							cookie: support.cookie,
							origin: support.origin,
							"content-type": form ? "application/x-www-form-urlencoded" : "application/json",
						},
						// update-client nests the metadata under `update`; the server's own payload check answers 400 without it.
						...(method === "post"
							? { body: form ? "" : path === "/oauth2/update-client" ? '{"client_id":"x","update":{}}' : "{}" }
							: {}),
					});
					const text = await response.text();
					expect(response.status, `${method.toUpperCase()} ${path}: ${text.slice(0, 160)}`).toBe(403);
					expect(text, path).toContain("IMPERSONATION_NOT_ALLOWED");
				}
			expect(
				await ownerRows(
					`SELECT (SELECT md5(string_agg(a::text, '|' ORDER BY a.id)) FROM account a WHERE a.user_id = $1) AS accounts,
					 (SELECT count(*) FROM apikey WHERE reference_id = $1)::text AS keys,
					 (SELECT email FROM "user" WHERE id = $1) AS email,
					 (SELECT two_factor_enabled FROM "user" WHERE id = $1) AS two_factor`,
					[support.member.id],
				),
			).toEqual(credentialsBefore);
			await rpc(support.origin, "impersonation.end", {}, memberSession(support));
		});

		// Q421 (fixed by #99, P3-T09): a support session must not be able to mint a credential that outlives it. Better Auth's
		// OAuth provider endpoints are not in IMPERSONATION_REFUSED_AUTH_PATHS, so the impersonator registers an OAuth client
		// in the member's name (scope api:read api:write api:delete, offline_access), consents to it and holds a bearer token
		// that works after the 60 minutes, with no support record behind it. Reproduced: both registration endpoints answer
		// 201 and /revoke-other-sessions answers 200 inside a live support session. Passes since #99.
		it("cannot mint a credential that outlives the session (OAuth clients and consent) or end the member's other sessions", async () => {
			const support = await startSupport();
			const client = {
				redirect_uris: ["https://client.example.test/callback"],
				client_name: "x",
				token_endpoint_auth_method: "none",
			};
			for (const [path, body] of [
				["/oauth2/create-client", client],
				["/oauth2/register", client],
				["/oauth2/consent", { accept: true }],
				["/revoke-other-sessions", {}],
			] as const) {
				const response = await hono.request(`${support.origin}/api/auth${path}`, {
					method: "POST",
					headers: { cookie: support.cookie, origin: support.origin, "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				const text = await response.text();
				expect(response.status, `${path}: ${text.slice(0, 160)}`).toBe(403);
				expect(text, path).toContain("IMPERSONATION_NOT_ALLOWED");
			}
			await rpc(support.origin, "impersonation.end", {}, memberSession(support));
		});

		// Q424 (DEFECT, fails today): Better Auth's global before-hook for /oauth2/delete-consent (packages/auth/src/config.ts)
		// revokes the member's refresh and access tokens for the client BEFORE the support-session guard (a plugin hook that
		// runs after it) refuses the call. The response is 403, but the member's OAuth grant is already revoked. Left failing
		// on purpose (not skipped).
		it("does not revoke the member's OAuth tokens through /oauth2/delete-consent in a support session", async () => {
			const support = await startSupport();
			const clientId = `q424-${run}`;
			const consentId = `q424c-${run}`;
			const tokenId = `q424t-${run}`;
			await owner.query(`INSERT INTO oauth_client (id, client_id, user_id, redirect_uris) VALUES ($1, $2, $3, $4)`, [
				`q424o-${run}`,
				clientId,
				support.member.id,
				["https://client.example.test/callback"],
			]);
			await owner.query(`INSERT INTO oauth_consent (id, client_id, user_id, scopes) VALUES ($1, $2, $3, $4)`, [
				consentId,
				clientId,
				support.member.id,
				["openid"],
			]);
			await owner.query(
				`INSERT INTO oauth_access_token (id, token, client_id, user_id, scopes) VALUES ($1, $2, $3, $4, $5)`,
				[tokenId, `q424-token-${run}`, clientId, support.member.id, ["openid"]],
			);
			const response = await hono.request(`${support.origin}/api/auth/oauth2/delete-consent`, {
				method: "POST",
				// A non-browser caller chooses its Origin header; a trusted one passes Better Auth's own cross-origin check.
				headers: { cookie: support.cookie, origin: PLATFORM_ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ id: consentId }),
			});
			const text = await response.text();
			const token = await ownerRows<{ revoked: Date | null }>(`SELECT revoked FROM oauth_access_token WHERE id = $1`, [
				tokenId,
			]);
			expect(response.status, text.slice(0, 160)).toBe(403);
			expect(text).toContain("IMPERSONATION_NOT_ALLOWED");
			expect(token.at(0)?.revoked ?? null, "the member's token is untouched").toBeNull();
			await rpc(support.origin, "impersonation.end", {}, memberSession(support));
		});

		it("is not a gate that refuses everything: the member's own session reaches the same Better Auth endpoints", async () => {
			// Same endpoint, same body, an ordinary session of the same member: not the support-session refusal.
			const response = await hono.request(`${originOf(orgs.a)}/api/auth/change-password`, {
				method: "POST",
				headers: { cookie: people.member.cookie, origin: originOf(orgs.a), "content-type": "application/json" },
				body: JSON.stringify({ currentPassword: "wrong-password-value", newPassword: "another-long-password-1" }),
			});
			expect(await response.text()).not.toContain("IMPERSONATION_NOT_ALLOWED");
			expect(response.status).not.toBe(403);
		});

		it("cannot call the procedures the policy lists, start another support session, or reach the console, over RPC", async () => {
			const support = await startSupport();
			const before = await snapshot();
			const paths = [...policy.IMPERSONATION_REFUSED_PROCEDURES.keys()];
			expect(paths.length).toBeGreaterThanOrEqual(8);
			for (const path of paths) {
				const reply = await rpc(support.origin, path, {}, memberSession(support));
				expect({ status: reply.status, data: reply.dataCode }, path).toEqual({
					status: 403,
					data: "IMPERSONATION_NOT_ALLOWED",
				});
			}
			// Another support session, and every console procedure, on the platform host and on the member's host.
			for (const origin of [PLATFORM_ORIGIN, support.origin])
				for (const procedure of SUPER_ADMIN_PROCEDURES) {
					const reply = await rpc(origin, procedure.path, procedure.input(seed), memberSession(support));
					expect(
						{ status: reply.status, data: reply.dataCode },
						`${procedure.path} on ${origin} in a support session`,
					).toEqual({ status: 403, data: "IMPERSONATION_NOT_ALLOWED" });
				}
			// And the support session still works for what it is for.
			expect((await rpc(support.origin, "branding.get", {}, memberSession(support))).status).toBe(200);
			expect(await snapshot()).toEqual(before);
			await rpc(support.origin, "impersonation.end", {}, memberSession(support));
		});

		it("refuses the same procedures to nobody else: the member's own session is served, not told it is a support session", async () => {
			const reply = await rpc(
				originOf(orgs.a),
				"auth.createApiKey",
				{ name: "own key", expiresIn: null, access: "read" },
				{
					cookie: people.member.cookie,
				},
			);
			expect(reply.dataCode).not.toBe("IMPERSONATION_NOT_ALLOWED");
			expect(reply.status).toBe(200);
		});

		it("cannot be forged: a session that claims an impersonator but has no live record is refused", async () => {
			const forged = await account("forged");
			await addMember(orgs.a.id, forged.id, "member");
			// A session row marked impersonated by the admin, as an attacker with the session table could write it.
			await owner.query(`UPDATE session SET impersonated_by = $2 WHERE user_id = $1`, [forged.id, people.admin.id]);
			expect((await rpc(originOf(orgs.a), "branding.get", {}, { cookie: forged.cookie })).status).toBe(401);
		});

		it("cannot be started by an admin who lost the role or the 2FA between start and redeem", async () => {
			const worker = await account("shortadmin");
			await setRole(worker.id, "admin", true);
			const started = await rpc(
				PLATFORM_ORIGIN,
				"admin.impersonation.start",
				{ organizationId: orgs.a.id, userId: people.member.id, reason: "security test: support ticket" },
				{ cookie: worker.cookie },
			);
			expect(started.status, started.text).toBe(200);
			await setRole(worker.id, "admin", false);
			const url = new URL((started.body as { json: { url: string } }).json.url);
			const params = new URLSearchParams(url.hash.slice(1));
			const response = await hono.request(`${url.origin}/api/careeros/impersonation/redeem`, {
				method: "POST",
				headers: { origin: url.origin, "content-type": "application/json" },
				body: JSON.stringify({ id: params.get("id"), token: params.get("token") }),
			});
			expect(response.status).toBe(400);
			expect(response.headers.getSetCookie()).toEqual([]);
		});
	});

	describe("audit log: what an organization sees of the console's work", () => {
		type Entry = { action: string; actorUserId: string | null; targetId: string | null; metadata: unknown };
		const trail = async (org: { slug: string }, cred: Cred) => {
			const reply = await rpc(originOf(org), "organization.audit", { limit: 100 }, cred);
			return {
				reply,
				items: ((reply.body as { json?: { items?: Entry[] } } | undefined)?.json?.items ?? []) as Entry[],
			};
		};

		it("shows an organization admin its own organization's entries, including what the console did to it, and nothing of another", async () => {
			// The console acts on both organizations, so each trail has its own rows.
			const adminCred = { cookie: people.admin.cookie };
			expect((await rpc(PLATFORM_ORIGIN, "admin.orgs.get", { organizationId: orgs.a.id }, adminCred)).status).toBe(200);
			expect((await rpc(PLATFORM_ORIGIN, "admin.orgs.get", { organizationId: orgs.b.id }, adminCred)).status).toBe(200);
			expect(
				(
					await rpc(
						PLATFORM_ORIGIN,
						"admin.orgs.setAiOverage",
						{ organizationId: orgs.b.id, allowed: true, reason: "security test: only B" },
						adminCred,
					)
				).status,
			).toBe(200);
			expect(
				(
					await rpc(
						PLATFORM_ORIGIN,
						"admin.orgs.setAiOverage",
						{ organizationId: orgs.a.id, allowed: false, reason: "security test: only A" },
						adminCred,
					)
				).status,
			).toBe(200);

			for (const [who, cred] of [
				["org owner", { cookie: people.orgOwner.cookie }],
				["org admin", { cookie: people.orgAdmin.cookie }],
			] as const) {
				const a = await trail(orgs.a, cred);
				expect(a.reply.status, who).toBe(200);
				const text = JSON.stringify(a.items);
				expect(
					a.items.some((entry) => entry.action === "admin.ai_overage_set"),
					`${who} sees the console's change`,
				).toBe(true);
				expect(text, `${who}: nothing of B`).not.toContain(orgs.b.id);
				expect(text, `${who}: nothing of B`).not.toContain("only B");
				// Platform-level rows (a list, the metrics) belong to no organization.
				expect(
					a.items.filter((entry) =>
						["admin.orgs_listed", "admin.metrics_viewed", "admin.audit_viewed"].includes(entry.action),
					),
				).toEqual([]);
			}

			const b = await trail(orgs.b, { cookie: people.bOwner.cookie });
			expect(b.reply.status).toBe(200);
			const bText = JSON.stringify(b.items);
			expect(b.items.some((entry) => entry.action === "admin.ai_overage_set")).toBe(true);
			expect(bText, "B's view never names A").not.toContain(orgs.a.id);
			expect(bText).not.toContain("only A");
			expect(b.items.some((entry) => entry.action === "admin.org_status_set")).toBe(false);
		});

		it("is not shown to a plain member, to another organization's owner, or to anyone on the other organization's host", async () => {
			expect((await trail(orgs.a, { cookie: people.member.cookie })).reply.status).toBe(403);
			// B's owner on A's host is not a member there: refused, never A's rows.
			const crossHost = await trail(orgs.a, { cookie: people.bOwner.cookie });
			expect(crossHost.reply.status).toBe(403);
			expect(crossHost.items).toEqual([]);
			expect((await trail(orgs.a, {})).reply.status).toBe(401);
		});
	});

	describe("suspension", () => {
		const suspendedOrg = { id: `sa-s-${run}`, slug: `sa-s-${run}`, name: `Suspended ${run}` };
		let founder: Account;
		const status = async () =>
			(await ownerRows<{ status: string }>(`SELECT status FROM organization WHERE id = $1`, [suspendedOrg.id]))[0]
				?.status;
		const adminSets = (next: "suspended" | "active") =>
			rpc(
				PLATFORM_ORIGIN,
				"admin.orgs.setStatus",
				{ organizationId: suspendedOrg.id, status: next, reason: `security test: ${next}` },
				{ cookie: people.admin.cookie },
			);
		const rename = (name: string) =>
			rpc(originOf(suspendedOrg), "branding.update", { appName: name }, { cookie: founder.cookie });

		beforeAll(async () => {
			await makeOrg(suspendedOrg, "pro");
			founder = await account("founder");
			await addMember(suspendedOrg.id, founder.id, "owner");
			await owner.query(`UPDATE session SET active_organization_id = $2 WHERE user_id = $1`, [
				founder.id,
				suspendedOrg.id,
			]);
		});

		it("lets members read but not write while suspended, allows the listed writes, and restores writes on unsuspend, both audited", async () => {
			// Before: a write works.
			expect((await rename("Before suspension")).status).toBe(200);

			expect((await adminSets("suspended")).status).toBe(200);
			expect(await status()).toBe("suspended");

			// Reads still work; the write is refused with the stable code and changes nothing.
			expect((await rpc(originOf(suspendedOrg), "branding.get", {}, { cookie: founder.cookie })).status).toBe(200);
			const refused = await rename("While suspended");
			expect({ status: refused.status, data: refused.dataCode }).toEqual({ status: 403, data: "ORG_SUSPENDED" });
			expect(
				(
					await ownerRows(`SELECT app_name FROM organization_branding WHERE organization_id = $1`, [suspendedOrg.id])
				)[0],
			).toMatchObject({ app_name: "Before suspension" });

			// The listed writes are not refused for suspension (they may fail for another reason, never ORG_SUSPENDED).
			const profile = await rpc(
				originOf(suspendedOrg),
				"auth.updateProfile",
				{ name: "Still Me" },
				{ cookie: founder.cookie },
			);
			expect(profile.status, profile.text).toBe(200);
			for (const path of ["billing.cancel", "billing.portal", "billing.checkout", "billing.changeSeats"]) {
				const reply = await rpc(originOf(suspendedOrg), path, {}, { cookie: founder.cookie });
				expect(reply.dataCode, path).not.toBe("ORG_SUSPENDED");
			}

			// Unsuspending restores writes.
			expect((await adminSets("active")).status).toBe(200);
			expect(await status()).toBe("active");
			expect((await rename("After unsuspension")).status).toBe(200);

			// Both changes are audited by the console and by the organization's own trail, with who and why.
			const rows = await ownerRows<{ action: string; actor_user_id: string; metadata: Record<string, unknown> }>(
				`SELECT action, actor_user_id, metadata FROM audit_log WHERE organization_id = $1 AND action IN ('admin.org_status_set', 'org.status_changed') ORDER BY created_at, id`,
				[suspendedOrg.id],
			);
			const adminRows = rows.filter((row) => row.action === "admin.org_status_set");
			expect(adminRows.map((row) => [row.actor_user_id, row.metadata.to, row.metadata.reason])).toEqual([
				[people.admin.id, "suspended", "security test: suspended"],
				[people.admin.id, "active", "security test: active"],
			]);
			expect(rows.filter((row) => row.action === "org.status_changed")).toHaveLength(2);
		});

		it("does not suspend a neighbour, and a suspended organization's member cannot lift it", async () => {
			expect((await adminSets("suspended")).status).toBe(200);
			const neighbour = await rpc(originOf(orgs.a), "branding.get", {}, { cookie: people.member.cookie });
			expect(neighbour.status).toBe(200);
			// The member's own session is no console credential, suspended or not.
			expectRefusal(
				await rpc(
					PLATFORM_ORIGIN,
					"admin.orgs.setStatus",
					{ organizationId: suspendedOrg.id, status: "active", reason: "let me out please" },
					{ cookie: founder.cookie },
				),
				EXPECTED_REFUSAL.member,
				"founder lifting own suspension",
			);
			expect(await status()).toBe("suspended");
			expect((await adminSets("active")).status).toBe(200);
		});
	});
});
