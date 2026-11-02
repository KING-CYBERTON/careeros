import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";

// P2-T03: sign-up, sessions and trusted origins on organization hosts, with the real Better Auth configuration on a
// database of its own (every migration applied), as the `careeros_app` role. Skipped only when the CAREEROS_TEST_*
// variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

const PASSWORD = "correct-horse-battery";
const PLATFORM = "localhost:3000";

describe.skipIf(!configured)("organization hosts: sign-up, sessions and trusted origins", () => {
	const run = randomUUID().slice(0, 8);
	const orgs = {
		open: { id: `open-${run}`, slug: `open-${run}` },
		closed: { id: `closed-${run}`, slug: `closed-${run}` },
	};
	const hostOf = (slug: string) => `${slug}.orgs.test`;
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let auth: typeof import("./config").auth;
	let tenancy: typeof import("@careeros/tenancy");

	const authRequest = (host: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
		auth.handler(
			new Request(`http://${host}/api/auth${path}`, {
				method: "POST",
				headers: { host, "content-type": "application/json", origin: `http://${host}`, ...headers },
				body: JSON.stringify(body),
			}),
		);
	const signUp = (host: string, label: string, extra: Record<string, unknown> = {}, email?: string) => {
		const suffix = randomUUID().slice(0, 8);
		const address = email ?? `${label}-${suffix}@example.test`;
		return {
			email: address,
			response: authRequest(host, "/sign-up/email", {
				name: label,
				email: address,
				password: PASSWORD,
				username: `${label}-${suffix}`,
				...extra,
			}),
		};
	};
	const memberships = async (email: string) =>
		(
			await owner.query<{ organization_id: string; role: string; slug: string }>(
				`SELECT m.organization_id, m.role, o.slug FROM member m JOIN organization o ON o.id = m.organization_id
				 JOIN "user" u ON u.id = m.user_id WHERE u.email = $1`,
				[email],
			)
		).rows;
	const activeOrgs = async (email: string) =>
		(
			await owner.query<{ active_organization_id: string | null }>(
				`SELECT s.active_organization_id FROM session s JOIN "user" u ON u.id = s.user_id WHERE u.email = $1`,
				[email],
			)
		).rows.map((row) => row.active_organization_id);
	const userExists = async (email: string) =>
		(await owner.query(`SELECT 1 FROM "user" WHERE email = $1`, [email])).rowCount === 1;
	const invite = async (
		organizationId: string,
		email: string,
		overrides: { status?: string; expiresAt?: Date } = {},
	) => {
		const id = `inv-${randomUUID()}`;
		await owner.query(
			`INSERT INTO invitation (id, organization_id, email, role, status, expires_at, inviter_id)
			 VALUES ($1, $2, $3, 'member', $4, $5, $6)`,
			[
				id,
				organizationId,
				email,
				overrides.status ?? "pending",
				overrides.expiresAt ?? new Date(Date.now() + 86_400_000),
				"inviter",
			],
		);
		return id;
	};

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("authhost_t03");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		// The configuration reads the environment when it is imported.
		process.env.DATABASE_URL = database.appUrl;
		process.env.ORG_HOST_PATTERN = "{slug}.orgs.test";
		process.env.APP_URL = `http://${PLATFORM}`;
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		await owner.query(
			`INSERT INTO "user" (id, name, email, username, display_username) VALUES ('inviter', 'Inviter', 'inviter@example.test', 'inviter', 'inviter')`,
		);
		for (const org of Object.values(orgs))
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $2)`, [org.id, org.slug]);
		await owner.query(`UPDATE organization_settings SET open_signup = true WHERE organization_id = $1`, [orgs.open.id]);
		({ auth } = await import("./config"));
		tenancy = await import("@careeros/tenancy");
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	describe("sign-up on an organization with open signup", () => {
		it("joins the host organization as member with no personal organization, and activates it", async () => {
			const { email, response } = signUp(hostOf(orgs.open.slug), "joiner");
			const result = await response;
			expect(result.status).toBe(200);
			expect(await memberships(email)).toEqual([
				{ organization_id: orgs.open.id, role: "member", slug: orgs.open.slug },
			]);
			expect(await activeOrgs(email)).toEqual([orgs.open.id]);
		});

		it("takes the organization from the host, never from the body", async () => {
			const { email, response } = signUp(hostOf(orgs.open.slug), "forger", {
				organizationId: orgs.closed.id,
				activeOrganizationId: orgs.closed.id,
			});
			expect((await response).status).toBe(200);
			expect((await memberships(email)).map((row) => row.organization_id)).toEqual([orgs.open.id]);
		});
	});

	describe("sign-up on an invite-only organization", () => {
		it("is refused with FORBIDDEN and ORG_SIGNUP_CLOSED, and creates nothing", async () => {
			const { email, response } = signUp(hostOf(orgs.closed.slug), "stranger");
			const result = await response;
			expect(result.status).toBe(403);
			expect(await result.json()).toMatchObject({ code: "ORG_SIGNUP_CLOSED" });
			expect(await userExists(email)).toBe(false);
		});

		it("is allowed with a pending invitation to the host organization for that email, and follows the invitation flow", async () => {
			const email = `invited-${randomUUID().slice(0, 8)}@example.test`;
			const invitationId = await invite(orgs.closed.id, email);
			const { response } = signUp(hostOf(orgs.closed.slug), "invited", { invitationId }, email);
			expect((await response).status).toBe(200);
			// Neither a personal organization nor a membership yet: the invitation is accepted afterwards.
			expect(await memberships(email)).toEqual([]);
		});

		it("refuses an invitation to another organization, to another email, an expired and an accepted one", async () => {
			const email = `wrong-${randomUUID().slice(0, 8)}@example.test`;
			const cases: [string, string][] = [
				["other organization", await invite(orgs.open.id, email)],
				["other email", await invite(orgs.closed.id, `someone-else-${run}@example.test`)],
				["expired", await invite(orgs.closed.id, email, { expiresAt: new Date(Date.now() - 1000) })],
				["accepted", await invite(orgs.closed.id, email, { status: "accepted" })],
			];
			for (const [label, invitationId] of cases) {
				const result = await signUp(hostOf(orgs.closed.slug), "wrong", { invitationId }, email).response;
				expect(result.status, label).toBe(403);
			}
			expect(await userExists(email)).toBe(false);
		});

		it("refuses an anonymous (guest) account too", async () => {
			const host = hostOf(orgs.closed.slug);
			const result = await authRequest(host, "/sign-in/anonymous", {});
			expect([403, 404]).toContain(result.status);
			expect(result.status === 403 ? await result.json() : { code: "ORG_SIGNUP_CLOSED" }).toMatchObject({
				code: expect.stringMatching(/ORG_SIGNUP_CLOSED|FORBIDDEN/),
			});
		});
	});

	describe("sign-up on the platform host", () => {
		it("is unchanged: one personal organization, the user is its owner", async () => {
			const { email, response } = signUp(PLATFORM, "platformer");
			expect((await response).status).toBe(200);
			const rows = await memberships(email);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ role: "owner" });
			expect(rows[0]?.slug).toMatch(/^u-/);
			expect(await activeOrgs(email)).toEqual([rows[0]?.organization_id]);
		});

		// CAREEROS (P3-T01): the organization table has plan and status columns the plugin does not know. Creating an
		// organization, as the signup hook and through the plugin's own endpoint, must still work as `careeros_app`, and
		// the organization starts on the personal plan, active, with a subscription row.
		it("creates organizations through the plugin on the personal plan, with a subscription row (P3-T01)", async () => {
			const { email, response } = signUp(PLATFORM, "planner");
			const signedUp = await response;
			expect(signedUp.status).toBe(200);
			const cookie = signedUp.headers
				.getSetCookie()
				.map((value) => value.split(";")[0])
				.join("; ");
			const created = await auth.api.createOrganization({
				body: { name: "Plan org", slug: `plan-${run}` },
				headers: new Headers({ cookie }),
			});
			const personal = (await memberships(email)).find((row) => row.slug.startsWith("u-"));
			expect(personal).toBeDefined();
			for (const organizationId of [created.id, personal?.organization_id]) {
				const { rows } = await owner.query(
					`SELECT o.plan_id, o.status, o.status_changed_at, s.plan_id AS subscription_plan, s.status AS subscription_status
					   FROM organization o JOIN subscription s ON s.organization_id = o.id WHERE o.id = $1`,
					[organizationId],
				);
				expect(rows).toEqual([
					{
						plan_id: "personal",
						status: "active",
						status_changed_at: null,
						subscription_plan: "personal",
						subscription_status: "none",
					},
				]);
			}
		});

		it("ignores X-Forwarded-Host while TRUST_FORWARDED_HOST is off", async () => {
			const { email, response } = (() => {
				const suffix = randomUUID().slice(0, 8);
				const address = `fwd-${suffix}@example.test`;
				return {
					email: address,
					response: authRequest(
						PLATFORM,
						"/sign-up/email",
						{ name: "fwd", email: address, password: PASSWORD, username: `fwd-${suffix}` },
						{ "x-forwarded-host": hostOf(orgs.closed.slug) },
					),
				};
			})();
			expect((await response).status).toBe(200);
			expect((await memberships(email))[0]?.role).toBe("owner");
		});

		it("a server-side call without a request falls back to the platform behaviour", async () => {
			const suffix = randomUUID().slice(0, 8);
			const email = `server-${suffix}@example.test`;
			await auth.api.signUpEmail({ body: { name: "s", email, password: PASSWORD, username: `server-${suffix}` } });
			expect((await memberships(email))[0]?.role).toBe("owner");
		});
	});

	describe("sessions and cookies", () => {
		it("sets host-only cookies: no Domain attribute, and cross-subdomain cookies are off", async () => {
			const { response } = signUp(hostOf(orgs.open.slug), "cookie");
			const result = await response;
			const cookies = result.headers.getSetCookie();
			expect(cookies.length).toBeGreaterThan(0);
			for (const cookie of cookies) expect(cookie).not.toMatch(/;\s*domain=/i);
			const context = await auth.$context;
			const advanced = context.options.advanced as { crossSubDomainCookies?: { enabled?: boolean } } | undefined;
			expect(advanced?.crossSubDomainCookies?.enabled).toBeFalsy();
		});

		it("a session from Org A's host does not open Org B's host", async () => {
			const { email, response } = signUp(hostOf(orgs.open.slug), "crosser");
			const cookie = (await response).headers
				.getSetCookie()
				.map((value) => value.split(";")[0])
				.join("; ");
			const headers = new Headers({ cookie });
			const session = await auth.api.getSession({ headers });
			const userId = session?.user.id ?? "";
			const authentication = {
				method: "session" as const,
				user: { id: userId },
				activeOrganizationId: (session?.session as { activeOrganizationId?: string } | undefined)?.activeOrganizationId,
			};
			expect(email).toContain("crosser");
			const hostContext = (slug: string, id: string) => ({
				kind: "org" as const,
				organizationId: id,
				slug,
				via: "subdomain" as const,
				hostname: hostOf(slug),
				origin: `http://${hostOf(slug)}`,
			});
			await expect(
				tenancy.resolveOrgForAuthentication(authentication, hostContext(orgs.open.slug, orgs.open.id)),
			).resolves.toBe(orgs.open.id);
			await expect(
				tenancy.resolveOrgForAuthentication(authentication, hostContext(orgs.closed.slug, orgs.closed.id)),
			).rejects.toMatchObject({ code: "not_member_of_host_org" });
		});
	});

	describe("trusted origins (Better Auth dynamic trustedOrigins)", () => {
		const trusted = async (request?: Request) => {
			const options = (await auth.$context).options.trustedOrigins;
			if (typeof options !== "function") throw new Error("trustedOrigins must be a function");
			return options(request);
		};

		it("adds the origin of an organization host to the platform origins", async () => {
			const host = hostOf(orgs.open.slug);
			const origins = await trusted(new Request(`http://${host}/api/auth/get-session`, { headers: { host } }));
			expect(origins).toContain(`http://${host}`);
			expect(origins).toContain(`http://${PLATFORM}`);
		});

		it("adds nothing for the platform host, an unknown organization host, or no request", async () => {
			const platform = await trusted(new Request(`http://${PLATFORM}/`, { headers: { host: PLATFORM } }));
			const unknown = await trusted(new Request("http://nobody.orgs.test/", { headers: { host: "nobody.orgs.test" } }));
			const none = await trusted(undefined);
			for (const origins of [platform, unknown, none]) {
				expect(origins).toContain(`http://${PLATFORM}`);
				expect(origins.some((origin) => origin?.includes("orgs.test"))).toBe(false);
			}
		});
	});
});
