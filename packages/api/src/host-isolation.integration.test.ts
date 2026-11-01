import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { call } from "@orpc/server";
import { Pool } from "pg";

// Real organization scope and real Better Auth, not the fixed ones from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());
vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

// P2-T03: the request host decides the organization, end to end through `protectedProcedure`: real sessions, real API
// keys, the real host resolver and row-level security as the `careeros_app` role, on a database of its own.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const PASSWORD = "correct-horse-battery";
const PLATFORM = "localhost:3000";

describe.skipIf(!configured)("host isolation through protectedProcedure", () => {
	const run = randomUUID().slice(0, 8);
	const orgA = { id: `iso-a-${run}`, slug: `iso-a-${run}`, appName: `Org A ${run}` };
	const orgB = { id: `iso-b-${run}`, slug: `iso-b-${run}`, appName: `Org B ${run}` };
	// Invite only (the default).
	const orgC = { id: `iso-c-${run}`, slug: `iso-c-${run}`, appName: `Org C ${run}` };
	const hostOf = (slug: string) => `${slug}.orgs.test`;
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let authConfig: typeof import("@reactive-resume/auth/config");
	let tenancy: typeof import("@careeros/tenancy");
	let branding: typeof import("./features/branding/router").brandingRouter;
	let organizationHost: typeof import("./features/organization-host/router").organizationHostRouter;

	const signUp = async (host: string, label: string) => {
		const suffix = randomUUID().slice(0, 8);
		const response = await authConfig.auth.handler(
			new Request(`http://${host}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { host, "content-type": "application/json", origin: `http://${host}` },
				body: JSON.stringify({
					name: label,
					email: `${label}-${suffix}@example.test`,
					password: PASSWORD,
					username: `${label}-${suffix}`,
				}),
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { user: { id: string } };
		const cookie = response.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		return { userId: body.user.id, cookie };
	};

	/** Calls `branding.get` the way the server adapters do: the host resolved from the request's Host header. */
	const getBranding = async (host: string, headers: Record<string, string>) => {
		const request = new Request(`http://${host}/api/rpc/branding/get`, { headers: { host, ...headers } });
		const hostContext = await tenancy.resolveHost(request);
		return call(branding.get, undefined, {
			context: { locale: "en-US", reqHeaders: request.headers, host: hostContext } as never,
		});
	};

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("apihost_t03");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.ORG_HOST_PATTERN = "{slug}.orgs.test";
		process.env.APP_URL = `http://${PLATFORM}`;
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		for (const org of [orgA, orgB, orgC]) {
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $2)`, [org.id, org.slug]);
			await owner.query(`UPDATE organization_branding SET app_name = $2 WHERE organization_id = $1`, [
				org.id,
				org.appName,
			]);
		}
		await owner.query(`UPDATE organization_settings SET open_signup = true WHERE organization_id = ANY($1)`, [
			[orgA.id, orgB.id],
		]);
		authConfig = await import("@reactive-resume/auth/config");
		tenancy = await import("@careeros/tenancy");
		({ brandingRouter: branding } = await import("./features/branding/router"));
		({ organizationHostRouter: organizationHost } = await import("./features/organization-host/router"));
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	describe("session cookie", () => {
		it("a member of Org A acts in Org A on Org A's host, and in no other organization", async () => {
			const { cookie } = await signUp(hostOf(orgA.slug), "member-a");
			const result = await getBranding(hostOf(orgA.slug), {
				cookie,
				origin: `http://${hostOf(orgA.slug)}`,
				// A client-supplied organization is never an input.
				"x-organization-id": orgB.id,
			});
			expect(result.appName).toBe(orgA.appName);
		});

		it("the same session cookie on Org B's host is refused with ORG_HOST_NOT_MEMBER", async () => {
			const { cookie } = await signUp(hostOf(orgA.slug), "member-a2");
			await expect(getBranding(hostOf(orgB.slug), { cookie, "x-organization-id": orgA.id })).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "ORG_HOST_NOT_MEMBER" },
			});
		});

		it("a cookie sent with the origin of another host is refused as a cross-site request", async () => {
			const { cookie } = await signUp(hostOf(orgA.slug), "member-a3");
			await expect(
				getBranding(hostOf(orgA.slug), { cookie, origin: `http://${hostOf(orgB.slug)}` }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});

		it("on the platform host the session's active organization decides, as in Phase 1", async () => {
			const { cookie } = await signUp(hostOf(orgA.slug), "platform-a");
			const result = await getBranding(PLATFORM, { cookie });
			expect(result.appName).toBe(orgA.appName);
		});

		it("an unknown organization host answers NOT_FOUND, never the platform rules", async () => {
			const { cookie } = await signUp(hostOf(orgA.slug), "unknown-a");
			await expect(getBranding(hostOf(`nobody-${run}`), { cookie })).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});

	describe("API key", () => {
		const createKey = async (userId: string, organizationId: string | null) => {
			const created = await authConfig.auth.api.createApiKey({ body: { userId } });
			await owner.query(`UPDATE apikey SET organization_id = $2 WHERE id = $1`, [created.id, organizationId]);
			return created.key;
		};

		it("a key bound to Org A acts in Org A on Org A's host and is refused on Org B's host", async () => {
			const { userId } = await signUp(hostOf(orgA.slug), "key-a");
			// The key's owner is also a member of Org B: only the key's own organization counts.
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
				`m-${randomUUID()}`,
				orgB.id,
				userId,
			]);
			const key = await createKey(userId, orgA.id);
			expect((await getBranding(hostOf(orgA.slug), { "x-api-key": key })).appName).toBe(orgA.appName);
			await expect(getBranding(hostOf(orgB.slug), { "x-api-key": key })).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "ORG_HOST_KEY_MISMATCH" },
			});
		});

		it("a key on the platform host behaves as before", async () => {
			const { userId } = await signUp(hostOf(orgA.slug), "key-platform");
			const key = await createKey(userId, orgA.id);
			expect((await getBranding(PLATFORM, { "x-api-key": key })).appName).toBe(orgA.appName);
		});

		it("a key without an organization acts in the host organization for a member, and is refused otherwise", async () => {
			const { userId } = await signUp(hostOf(orgA.slug), "key-none");
			const key = await createKey(userId, null);
			expect((await getBranding(hostOf(orgA.slug), { "x-api-key": key })).appName).toBe(orgA.appName);
			await expect(getBranding(hostOf(orgB.slug), { "x-api-key": key })).rejects.toMatchObject({
				data: { code: "ORG_HOST_NOT_MEMBER" },
			});
		});
	});

	describe("join or switch", () => {
		const callHost = async (
			procedure: "status" | "join",
			host: string,
			headers: Record<string, string>,
		): Promise<unknown> => {
			const request = new Request(`http://${host}/api/rpc/organizationHost/${procedure}`, {
				headers: { host, ...headers },
			});
			const hostContext = await tenancy.resolveHost(request);
			return call(organizationHost[procedure] as never, undefined as never, {
				context: { locale: "en-US", reqHeaders: request.headers, host: hostContext } as never,
			});
		};
		const memberRows = async (userId: string, organizationId: string) =>
			Number(
				(
					await owner.query<{ n: string }>(
						`SELECT count(*) AS n FROM member WHERE user_id = $1 AND organization_id = $2`,
						[userId, organizationId],
					)
				).rows[0]?.n,
			);

		it("reports a non-member's standing on an organization host, which has open signup", async () => {
			const { cookie } = await signUp(hostOf(orgB.slug), "visitor-status");
			expect(await callHost("status", hostOf(orgA.slug), { cookie })).toEqual({
				slug: orgA.slug,
				isMember: false,
				openSignup: true,
			});
		});

		it("lets a signed-in user join an open organization, once, and then the host works for them", async () => {
			const { userId, cookie } = await signUp(hostOf(orgB.slug), "visitor-join");
			await expect(getBranding(hostOf(orgA.slug), { cookie })).rejects.toMatchObject({
				data: { code: "ORG_HOST_NOT_MEMBER" },
			});
			expect(await callHost("join", hostOf(orgA.slug), { cookie })).toEqual({ slug: orgA.slug, isMember: true });
			expect(await memberRows(userId, orgA.id)).toBe(1);
			expect((await getBranding(hostOf(orgA.slug), { cookie })).appName).toBe(orgA.appName);
			await expect(callHost("join", hostOf(orgA.slug), { cookie })).rejects.toMatchObject({ code: "CONFLICT" });
			expect(await memberRows(userId, orgA.id)).toBe(1);
		});

		it("refuses to join an invite-only organization", async () => {
			const { userId, cookie } = await signUp(hostOf(orgB.slug), "visitor-closed");
			await expect(callHost("join", hostOf(orgC.slug), { cookie })).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "ORG_SIGNUP_CLOSED" },
			});
			expect(await memberRows(userId, orgC.id)).toBe(0);
			expect(await callHost("status", hostOf(orgC.slug), { cookie })).toMatchObject({ openSignup: false });
		});

		it("does not let an API key join, and has no organization to join on the platform host", async () => {
			const { userId, cookie } = await signUp(hostOf(orgB.slug), "visitor-key");
			const created = await authConfig.auth.api.createApiKey({ body: { userId } });
			await expect(callHost("join", hostOf(orgA.slug), { "x-api-key": created.key })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(await memberRows(userId, orgA.id)).toBe(0);
			await expect(callHost("join", PLATFORM, { cookie })).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(callHost("status", PLATFORM, { cookie })).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});
});
