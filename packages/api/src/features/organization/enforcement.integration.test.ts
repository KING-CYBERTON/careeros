import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { createRouterClient } from "@orpc/server";
import { Pool } from "pg";

// Real organization scope, real Better Auth and real entitlements, not the stand-ins of vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());
vi.mock("@careeros/billing", async (importOriginal) => importOriginal());
vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

// P3-T02: seats, suspension and plan features through `protectedProcedure`, end to end: real sessions and API keys,
// the real host resolver and row-level security as the `careeros_app` role, on a database of its own. Skipped only
// when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const PASSWORD = "correct-horse-battery";
const PLATFORM = "localhost:3000";

// oxlint-disable-next-line typescript/no-explicit-any -- the test clients are built from dotted paths, so their shape is not known statically.
type Loose = Record<string, any>;

type Credential = { cookie: string } | { apiKey: string };

describe.skipIf(!configured)("entitlement enforcement through protectedProcedure", () => {
	const hostOf = (slug: string) => `${slug}.orgs.test`;
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let authConfig: typeof import("@reactive-resume/auth/config");
	let tenancy: typeof import("@careeros/tenancy");
	let client: Client;

	type Client = Loose;
	let allowedClient: Client;
	const makeClient = (router: object, context: () => Promise<Record<string, unknown>>) =>
		createRouterClient(router as never, { context }) as never as Client;
	/** Builds `{ a: { b: stub } }` for each dotted path, so a stub sits at the router path the allow-list names. */
	const nest = (paths: Iterable<string>, make: () => unknown) => {
		const root: Loose = {};
		for (const path of paths) {
			const parts = path.split(".");
			let node = root;
			for (const part of parts.slice(0, -1)) node = node[part] ??= {};
			node[parts.at(-1) as string] = make();
		}
		return root;
	};

	const signUp = async (label: string) => {
		const suffix = randomUUID().slice(0, 8);
		const email = `${label}-${suffix}@example.test`;
		const response = await authConfig.auth.handler(
			new Request(`http://${PLATFORM}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { host: PLATFORM, "content-type": "application/json", origin: `http://${PLATFORM}` },
				body: JSON.stringify({ name: label, email, password: PASSWORD, username: `${label}-${suffix}` }),
			}),
		);
		expect(response.status).toBe(200);
		const { user } = (await response.json()) as { user: { id: string } };
		const cookie = response.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		return { userId: user.id, email, cookie };
	};

	/** A new organization (plan and status given) with a founder whose session acts in it. */
	const makeOrganization = async (plan: string, status: string | null = null) => {
		const founder = await signUp("founder");
		const id = `enf-${randomUUID().slice(0, 12)}`;
		await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [id]);
		await owner.query(`SELECT careeros_set_org_plan($1, $2, $3, NULL, 'test fixture')`, [id, plan, status]);
		await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [
			`m-${randomUUID()}`,
			id,
			founder.userId,
		]);
		await owner.query(`UPDATE session SET active_organization_id = $2 WHERE user_id = $1`, [founder.userId, id]);
		const key = await authConfig.auth.api.createApiKey({ body: { userId: founder.userId } });
		await owner.query(`UPDATE apikey SET organization_id = $2 WHERE id = $1`, [key.id, id]);
		return { id, founder, apiKey: key.key, apiKeyId: key.id };
	};
	const setStatus = (id: string, status: string) =>
		owner.query(`SELECT careeros_set_org_plan($1, NULL, $2, NULL, 'test')`, [id, status]);

	const requestContext = async (credential: Credential, host: string) => {
		const headers: Record<string, string> =
			"cookie" in credential
				? { cookie: credential.cookie, origin: `http://${host}` }
				: { "x-api-key": credential.apiKey };
		const reqHeaders = new Headers({ host, ...headers });
		const hostContext = await tenancy.resolveHost(new Request(`http://${host}/`, { headers: reqHeaders }));
		return { locale: "en-US", reqHeaders, host: hostContext };
	};
	let current: { credential: Credential; host: string } = { credential: { cookie: "" }, host: PLATFORM };
	const as = (credential: Credential, host = PLATFORM) => {
		current = { credential, host };
		return client;
	};

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("apienf_t02");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.ORG_HOST_PATTERN = "{slug}.orgs.test";
		process.env.APP_URL = `http://${PLATFORM}`;
		vi.resetModules();
		const dbClient = await import("@reactive-resume/db/client");
		restorePool = dbClient.bindGlobalPoolForTesting(app);
		await owner.query(`UPDATE plan SET seat_limit = 3 WHERE id = 'starter'`);
		authConfig = await import("@reactive-resume/auth/config");
		tenancy = await import("@careeros/tenancy");
		const { default: routers } = await import("../../routers/index");
		const { protectedProcedure } = await import("../../context");
		const { SUSPENDED_ORG_ALLOWED_WRITES } = await import("../../middleware/entitlements");
		const stub = (method: "GET" | "POST") =>
			protectedProcedure.route({ method, path: `/stub/${randomUUID()}`, tags: ["Internal"] }).handler(() => "done");
		const context = () => requestContext(current.credential, current.host);
		client = makeClient({ ...routers, probe: { read: stub("GET"), write: stub("POST") } }, context);
		// One stub per allow-listed path, at that exact router path (the allow-list is keyed by it).
		allowedClient = makeClient(
			nest([...SUSPENDED_ORG_ALLOWED_WRITES.keys()], () => stub("POST")),
			context,
		);
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	describe("a suspended organization is read-only", () => {
		it("reads, but cannot write, through a session", async () => {
			const org = await makeOrganization("pro", "suspended");
			const api = as({ cookie: org.founder.cookie });
			await expect(api.branding.get()).resolves.toBeTruthy();
			await expect(api.probe.read()).resolves.toBe("done");
			await expect(api.probe.write()).rejects.toMatchObject({ code: "FORBIDDEN", data: { code: "ORG_SUSPENDED" } });
			await expect(api.branding.update({ appName: "Renamed" })).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "ORG_SUSPENDED" },
			});
			const [{ app_name }] = (
				await owner.query(`SELECT app_name FROM organization_branding WHERE organization_id = $1`, [org.id])
			).rows;
			expect(app_name).not.toBe("Renamed");
		});

		it("cannot write through an API key (the same rule)", async () => {
			const org = await makeOrganization("pro", "suspended");
			const api = as({ apiKey: org.apiKey });
			await expect(api.branding.get()).resolves.toBeTruthy();
			await expect(api.probe.write()).rejects.toMatchObject({ code: "FORBIDDEN", data: { code: "ORG_SUSPENDED" } });
			await expect(api.branding.update({ appName: "ViaKey" })).rejects.toMatchObject({
				data: { code: "ORG_SUSPENDED" },
			});
		});

		it("cannot write through the MCP client, which calls the same router with a preset authentication", async () => {
			const org = await makeOrganization("pro", "suspended");
			const { default: routers } = await import("../../routers/index");
			const mcp = createRouterClient(routers as never, {
				context: () => ({
					locale: "en-US",
					reqHeaders: new Headers(),
					authentication: {
						user: { id: org.founder.userId },
						method: "apiKey",
						permissions: ["read", "write", "delete"],
						apiKeyId: org.apiKeyId,
					},
				}),
			}) as never as Loose;
			await expect(mcp.branding.get()).resolves.toBeTruthy();
			await expect(mcp.branding.update({ appName: "ViaMcp" })).rejects.toMatchObject({
				data: { code: "ORG_SUSPENDED" },
			});
		});

		it("can still do every allow-listed write, while the same call at an unlisted path is refused", async () => {
			const org = await makeOrganization("pro", "suspended");
			as({ cookie: org.founder.cookie });
			const { SUSPENDED_ORG_ALLOWED_WRITES } = await import("../../middleware/entitlements");
			expect(SUSPENDED_ORG_ALLOWED_WRITES.size).toBeGreaterThan(0);
			for (const path of SUSPENDED_ORG_ALLOWED_WRITES.keys()) {
				const procedure = path.split(".").reduce<Loose>((node, part) => node[part], allowedClient);
				await expect(procedure(), path).resolves.toBe("done");
			}
			await expect(client.probe.write()).rejects.toMatchObject({ data: { code: "ORG_SUSPENDED" } });
		});

		it("accepts writes again when the organization is reactivated", async () => {
			const org = await makeOrganization("pro", "suspended");
			const api = as({ cookie: org.founder.cookie });
			await expect(api.probe.write()).rejects.toMatchObject({ data: { code: "ORG_SUSPENDED" } });
			await setStatus(org.id, "active");
			await expect(api.probe.write()).resolves.toBe("done");
		});

		it("does not suspend a neighbouring organization", async () => {
			const suspended = await makeOrganization("pro", "suspended");
			const neighbour = await makeOrganization("pro");
			await expect(as({ cookie: neighbour.founder.cookie }).probe.write()).resolves.toBe("done");
			await expect(as({ cookie: suspended.founder.cookie }).probe.write()).rejects.toBeTruthy();
		});
	});

	describe("plan features", () => {
		const addDomain = (credential: Credential) =>
			as(credential).organizationDomain.add({ hostname: "careers.example.test" });

		it("refuses a feature the plan lacks, naming the key, and passes the gate on a plan that has it", async () => {
			const starter = await makeOrganization("starter");
			await expect(addDomain({ cookie: starter.founder.cookie })).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "FEATURE_NOT_IN_PLAN", feature: "custom_domain" },
			});
			const pro = await makeOrganization("pro");
			// Past the gate the call stops at the missing Cloudflare settings (412), not at the plan.
			await expect(addDomain({ cookie: pro.founder.cookie })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		});

		it("follows an organization-level flag in both directions", async () => {
			const starter = await makeOrganization("starter");
			await owner.query(
				`INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ($1, $2, 'custom_domain', true)`,
				[`ff-${randomUUID()}`, starter.id],
			);
			await expect(addDomain({ cookie: starter.founder.cookie })).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
			});

			const pro = await makeOrganization("pro");
			await owner.query(
				`INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ($1, $2, 'custom_domain', false)`,
				[`ff-${randomUUID()}`, pro.id],
			);
			await expect(addDomain({ cookie: pro.founder.cookie })).rejects.toMatchObject({
				data: { code: "FEATURE_NOT_IN_PLAN" },
			});
		});

		it("does not gate removing or listing domains, so a downgraded organization can clean up", async () => {
			const starter = await makeOrganization("starter");
			const api = as({ cookie: starter.founder.cookie });
			await expect(api.organizationDomain.list()).resolves.toEqual([]);
			await expect(api.organizationDomain.remove({ id: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});

	describe("joining an organization host with open signup", () => {
		const open = async (plan: string, status: string | null = null) => {
			const org = await makeOrganization(plan, status);
			await owner.query(`UPDATE organization_settings SET open_signup = true WHERE organization_id = $1`, [org.id]);
			return org;
		};

		it("takes a seat until the limit and then answers SEAT_LIMIT_REACHED", async () => {
			const org = await open("starter");
			// Starter limit 3: the founder holds one seat.
			for (const label of ["j1", "j2"]) {
				const person = await signUp(label);
				await expect(as({ cookie: person.cookie }, hostOf(org.id)).organizationHost.join()).resolves.toMatchObject({
					isMember: true,
				});
			}
			const late = await signUp("j3");
			await expect(as({ cookie: late.cookie }, hostOf(org.id)).organizationHost.join()).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "SEAT_LIMIT_REACHED" },
			});
			const { rowCount } = await owner.query(`SELECT 1 FROM member WHERE organization_id = $1 AND user_id = $2`, [
				org.id,
				late.userId,
			]);
			expect(rowCount).toBe(0);
		});

		it("answers ORG_SUSPENDED while the organization is suspended", async () => {
			const org = await open("pro", "suspended");
			const person = await signUp("sj");
			await expect(as({ cookie: person.cookie }, hostOf(org.id)).organizationHost.join()).rejects.toMatchObject({
				data: { code: "ORG_SUSPENDED" },
			});
		});

		it("lets a person who is already a member see CONFLICT, not a seat error, in a full organization", async () => {
			const org = await open("starter");
			const person = await signUp("again");
			await as({ cookie: person.cookie }, hostOf(org.id)).organizationHost.join();
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
				`m-${randomUUID()}`,
				org.id,
				(await signUp("fill")).userId,
			]);
			await expect(as({ cookie: person.cookie }, hostOf(org.id)).organizationHost.join()).rejects.toMatchObject({
				code: "CONFLICT",
			});
		});
	});

	describe("the entitlements procedure", () => {
		it("shows a suspended organization as read-only to its members", async () => {
			const org = await makeOrganization("starter", "suspended");
			const result = await as({ cookie: org.founder.cookie }).organization.entitlements();
			expect(result).toMatchObject({
				planId: "starter",
				status: "suspended",
				readOnly: true,
				seatLimit: 3,
				seatsUsed: 1,
			});
			expect(result.features.custom_domain).toBe(false);
		});
	});
});
