import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { call } from "@orpc/server";
import { Pool, type PoolClient } from "pg";
import { withDatabasePool } from "@reactive-resume/db/client";
import { FakeCloudflare } from "./fake-cloudflare";

// Cloudflare for SaaS settings, the org host pattern and the per-user custom domain target for this file, set before
// any module reads the environment.
const TOKEN = vi.hoisted(() => {
	process.env.CF_SAAS_API_TOKEN = "cf-integration-token-NEVER-LOG-ME";
	process.env.CF_ZONE_ID = "0123456789abcdef0123456789abcdef";
	process.env.CF_SAAS_CNAME_TARGET = "saas.customers.example.test";
	process.env.ORG_HOST_PATTERN = "{slug}-orgs.example.test";
	process.env.CUSTOM_DOMAIN_TARGET = "domains.example.test";
	process.env.CUSTOM_DOMAIN_PROVIDER_SECRET = "integration-provider-secret-32-characters";
	return "cf-integration-token-NEVER-LOG-ME";
});

// Real organization scope, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());
vi.mock("@reactive-resume/auth/config", () => ({ auth: {}, verifyOAuthToken: vi.fn() }));

// What the TXT lookup answers for each hostname; the DNS module is the only thing replaced.
const txtAnswers = vi.hoisted(() => new Map<string, "proved" | "missing" | "unknown">());
const txtChecks = vi.hoisted(() => [] as { hostname: string; token: string }[]);
vi.mock("./dns", async (importOriginal) => ({
	...(await importOriginal<typeof import("./dns")>()),
	checkTxtProof: async (hostname: string, token: string) => {
		txtChecks.push({ hostname, token });
		return txtAnswers.get(hostname) ?? "missing";
	},
}));

// P2-T06: organization custom domains on a database of its own with every migration applied, as the `careeros_app`
// role (NOBYPASSRLS). Cloudflare is an in-memory fake handed in through fetch; DNS answers come from a map. Skipped
// only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("organization custom domains (real Postgres)", () => {
	const run = randomUUID().slice(0, 8);
	// Every test gets two fresh organizations (an organization may hold only five domains).
	type Party = { org: string; owner: string; admin: string; member: string };
	let A: Party;
	let B: Party;
	let counter = 0;
	const host = (label: string) => `${label}.acme.example.test`;
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let fake: FakeCloudflare;
	let logs: string[];
	let router: typeof import("./router").organizationDomainRouter;
	let jobs: typeof import("./jobs");
	let process_: typeof import("./process");
	let tenancy: typeof import("@careeros/tenancy");
	let customDomain: typeof import("../custom-domain/service");

	const inApp = <T>(fn: () => T) => withDatabasePool(app, fn);
	const asUser = (userId: string, organizationId: string | null) => ({
		authentication: {
			user: { id: userId },
			method: "session" as const,
			permissions: ["read", "write", "delete"] as const,
			activeOrganizationId: organizationId,
		},
		reqHeaders: new Headers(),
		locale: "en-US",
	});
	const invoke = <T>(procedure: unknown, input: unknown, context: unknown): Promise<T> =>
		inApp(() => call(procedure as never, input as never, { context: context as never })) as Promise<T>;
	const asAdminA = () => asUser(A.admin, A.org);
	const add = (hostname: string, context: unknown = asAdminA()) =>
		invoke<{ id: string; hostname: string; status: string; records: { type: string; name: string; value: string }[] }>(
			router.add,
			{ hostname },
			context,
		);
	const list = (context: unknown = asAdminA()) =>
		invoke<{ id: string; hostname: string; status: string }[]>(router.list, undefined, context);
	const recheck = (id: string, context: unknown = asAdminA()) =>
		invoke<{ id: string; status: string; failureReason: string | null }>(router.recheck, { id }, context);
	const remove = (id: string, context: unknown = asAdminA()) => invoke(router.remove, { id }, context);
	const row = async (id: string) =>
		(await owner.query(`SELECT * FROM organization_domain WHERE id = $1`, [id])).rows[0] as
			| Record<string, unknown>
			| undefined;
	const rowByHost = async (hostname: string) =>
		(await owner.query(`SELECT * FROM organization_domain WHERE hostname = $1`, [hostname])).rows[0] as
			| Record<string, unknown>
			| undefined;
	const age = (id: string, column: string, interval: string) =>
		owner.query(`UPDATE organization_domain SET ${column} = now() - $2::interval WHERE id = $1`, [id, interval]);
	const resolvesTo = async (hostname: string) =>
		(await app.query(`SELECT organization_id FROM careeros_org_for_custom_host($1)`, [hostname])).rows[0]
			?.organization_id as string | undefined;
	const deps = (cloudflare = true) => ({
		cloudflare: cloudflare
			? (process_.defaultProcessDeps().cloudflare as NonNullable<
					ReturnType<typeof process_.defaultProcessDeps>["cloudflare"]
				>)
			: null,
		checkTxt: async (hostname: string, token: string) => {
			txtChecks.push({ hostname, token });
			return txtAnswers.get(hostname) ?? "missing";
		},
	});
	const runJobs = () => inApp(() => jobs.runOrgDomainJobs(deps()));
	const makeDue = (id: string) => age(id, "last_checked_at", "10 minutes");
	const makeDailyDue = (id: string) => age(id, "last_checked_at", "25 hours");

	/** Takes a domain from `pending` to `active` through the job, as the status machine does. */
	const activate = async (hostname: string, context: unknown = asAdminA()) => {
		const created = await add(hostname, context);
		txtAnswers.set(hostname, "proved");
		await runJobs();
		fake.setStatus(hostname, "active", "active");
		await makeDue(created.id);
		await runJobs();
		expect((await row(created.id))?.status).toBe("active");
		return created.id;
	};

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("orgdom_t06");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		({ organizationDomainRouter: router } = await import("./router"));
		jobs = await import("./jobs");
		process_ = await import("./process");
		tenancy = await import("@careeros/tenancy");
		customDomain = await import("../custom-domain/service");
	}, 120_000);

	async function party(label: string): Promise<Party> {
		const n = ++counter;
		const made = {
			org: `dom-${label}-${n}-${run}`,
			owner: `dom-o${label}-${n}-${run}`,
			admin: `dom-a${label}-${n}-${run}`,
			member: `dom-m${label}-${n}-${run}`,
		};
		await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [made.org]);
		for (const [user, role] of [
			[made.owner, "owner"],
			[made.admin, "admin"],
			[made.member, "member"],
		] as const) {
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[user],
			);
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $1, $3)`, [
				user,
				made.org,
				role,
			]);
		}
		return made;
	}

	beforeEach(async () => {
		A = await party("a");
		B = await party("b");
		fake = new FakeCloudflare();
		vi.stubGlobal("fetch", fake.fetch);
		txtAnswers.clear();
		txtChecks.length = 0;
		logs = [];
		for (const method of ["log", "info", "warn", "error", "debug"] as const)
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
			});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		tenancy.setHostResolverForTesting(undefined);
	});

	afterAll(async () => {
		await owner?.end();
		await app?.end();
		await database?.drop();
	});

	describe("adding a domain", () => {
		it("lets an owner or admin add one: pending, with the TXT proof and the CNAME to show", async () => {
			const created = await add(host("careers"));
			expect(created).toMatchObject({ hostname: host("careers"), status: "pending" });
			const stored = await rowByHost(host("careers"));
			expect(stored).toMatchObject({ organization_id: A.org, status: "pending", created_by: A.admin });
			const token = String(stored?.verification_token);
			// 128 bits or more.
			expect(Buffer.from(token, "base64url").length).toBeGreaterThanOrEqual(16);
			expect(created.records).toEqual([
				{ type: "TXT", name: `_careeros-verify.${host("careers")}`, value: `careeros-verify=${token}` },
				{ type: "CNAME", name: host("careers"), value: "saas.customers.example.test" },
			]);
			// Nothing talks to Cloudflare, and nothing resolves, until the TXT record proves ownership.
			expect(fake.requests).toHaveLength(0);
			expect(await resolvesTo(host("careers"))).toBeUndefined();
			await expect(add(host("by-owner"), asUser(A.owner, A.org))).resolves.toMatchObject({ status: "pending" });
		});

		it("refuses a plain member, and an unrelated person, on every procedure", async () => {
			const member = asUser(A.member, A.org);
			await expect(add(host("nope"), member)).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(list(member)).rejects.toMatchObject({ code: "FORBIDDEN" });
			const id = (await add(host("member-target"))).id;
			await expect(recheck(id, member)).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(remove(id, member)).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(await rowByHost(host("nope"))).toBeUndefined();
		});

		it("normalizes the name and refuses what is not a public domain", async () => {
			await expect(add("  HTTPS://Normal.Acme.Example.Test/path?x=1 ")).resolves.toMatchObject({
				hostname: "normal.acme.example.test",
			});
			for (const bad of ["localhost", "a b", "192.168.0.1", "singlelabel", "", "foo.localhost"])
				await expect(add(bad), bad).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});

		it("refuses the platform's hosts, the Cloudflare target and the organization host pattern (and what is under them)", async () => {
			for (const reserved of [
				"saas.customers.example.test",
				"sub.saas.customers.example.test",
				"domains.example.test",
				"x.domains.example.test",
				"acme-orgs.example.test",
				"x-y-orgs.example.test",
			])
				await expect(add(reserved), reserved).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});

		it("enforces the same rules inside the definer function, whatever the caller passes", async () => {
			const claim = (hostname: string, reserved: string[] | null, prefix: string | null, suffix: string | null) =>
				inApp(async () => {
					const client = await app.connect();
					try {
						await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [A.org]);
						return await client.query(`SELECT careeros_claim_org_domain($1, $2, $3, 'tok', $4, $5::text[], $6, $7)`, [
							A.org,
							randomUUID(),
							hostname,
							A.admin,
							reserved,
							prefix,
							suffix,
						]);
					} finally {
						await client.query(`SELECT set_config('app.current_org_id', '', false)`);
						client.release();
					}
				});
			await expect(claim("app.platform.test", ["platform.test"], null, null)).rejects.toThrow(/reserved_host/);
			await expect(claim("platform.test", ["platform.test"], null, null)).rejects.toThrow(/reserved_host/);
			await expect(claim("x-orgs.platform.test", null, "", "-orgs.platform.test")).rejects.toThrow(/reserved_host/);
			await expect(claim("pre-x.platform.test", null, "pre-", ".platform.test")).rejects.toThrow(/reserved_host/);
			await expect(claim("Bad_Name", null, null, null)).rejects.toThrow(/invalid_hostname/);
			await expect(claim("single", null, null, null)).rejects.toThrow(/invalid_hostname/);
			await expect(claim("fine.platform.test", ["other.test"], "", "-orgs.platform.test")).resolves.toBeDefined();
			expect((await rowByHost("fine.platform.test"))?.status).toBe("pending");
		});

		it("acts only for the caller's own organization, even when asked for another", async () => {
			await expect(
				inApp(async () => {
					const client = await app.connect();
					try {
						await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [A.org]);
						return await client.query(`SELECT careeros_claim_org_domain($1, $2, 'steal.example.test', 'tok', $3)`, [
							B.org,
							randomUUID(),
							A.admin,
						]);
					} finally {
						await client.query(`SELECT set_config('app.current_org_id', '', false)`);
						client.release();
					}
				}),
			).rejects.toThrow(/not the current one/);
			expect(await rowByHost("steal.example.test")).toBeUndefined();
		});

		it("answers the same way for a name another organization holds and for a name a personal domain holds", async () => {
			await add(host("taken"));
			const otherOrg = await add(host("taken"), asUser(B.owner, B.org)).catch((error: unknown) => error);
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ('p1','p','p@x.test','p1','p1') ON CONFLICT DO NOTHING`,
			);
			await owner.query(
				`INSERT INTO custom_domain (organization_id, user_id, hostname, verification_token) VALUES ($1, 'p1', $2, 't')`,
				[B.org, host("personal")],
			);
			const personal = await add(host("personal"), asUser(B.owner, B.org)).catch((error: unknown) => error);
			for (const error of [otherOrg, personal])
				expect(error).toMatchObject({
					code: "CONFLICT",
					message: "That domain isn't available.",
					data: { code: "DOMAIN_UNAVAILABLE" },
				});
			// B did not get a row, and A still has its own.
			expect((await rowByHost(host("taken")))?.organization_id).toBe(A.org);
			expect(await rowByHost(host("personal"))).toBeUndefined();
			await expect(add(host("taken"))).rejects.toMatchObject({ data: { code: "DOMAIN_EXISTS" } });
		});

		it("refuses a name an organization holds when an account adds it as a personal custom domain", async () => {
			await add(host("reverse"));
			await expect(
				inApp(async () => {
					const client = await app.connect();
					try {
						await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [B.org]);
						await client.query(
							`INSERT INTO custom_domain (organization_id, user_id, hostname, verification_token) VALUES ($1, 'p1', $2, 't2')`,
							[B.org, host("reverse")],
						);
					} finally {
						await client.query(`SELECT set_config('app.current_org_id', '', false)`);
						client.release();
					}
				}),
			).rejects.toThrow(/hostname_taken/);
			// The upstream service maps the trigger's error to a clean CONFLICT.
			await expect(
				inApp(() => tenancy.withOrgContext(B.org, () => customDomain.customDomainService.set("p1", host("reverse")))),
			).rejects.toMatchObject({ code: "CONFLICT", data: { code: "DOMAIN_UNAVAILABLE" } });
			// Changing an existing row's hostname to a held name is refused too, and unrelated updates still work.
			await inApp(() =>
				tenancy.withOrgContext(B.org, async () => {
					const client = await app.connect();
					client.release();
				}),
			);
			await expect(
				owner.query(`UPDATE custom_domain SET hostname = $1 WHERE user_id = 'p1'`, [host("reverse")]),
			).rejects.toThrow(/hostname_taken/);
			await expect(
				owner.query(`UPDATE custom_domain SET verified_at = now() WHERE user_id = 'p1'`),
			).resolves.toBeDefined();
			await owner.query(`DELETE FROM custom_domain WHERE user_id = 'p1'`);
		});

		it("caps an organization at five domains, in the service and in the database", async () => {
			const org = `dom-cap-${run}`;
			const user = `dom-cap-user-${run}`;
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[user],
			);
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $1, 'owner')`, [
				user,
				org,
			]);
			const context = asUser(user, org);
			for (let n = 0; n < 5; n++) await add(`cap${n}.acme.example.test`, context);
			await expect(add("cap5.acme.example.test", context)).rejects.toMatchObject({ data: { code: "DOMAIN_LIMIT" } });
			await expect(list(context)).resolves.toHaveLength(5);
			// The database function holds the line on its own, even when the service check is bypassed.
			await expect(
				inApp(async () => {
					const client = await app.connect();
					try {
						await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [org]);
						await client.query(`SELECT careeros_claim_org_domain($1, $2, 'cap6.acme.example.test', 't', $3)`, [
							org,
							randomUUID(),
							user,
						]);
					} finally {
						await client.query(`SELECT set_config('app.current_org_id', '', false)`);
						client.release();
					}
				}),
			).rejects.toThrow(/domain_limit/);
			// Seven concurrent adds into a fresh organization: exactly five win.
			const burstOrg = `dom-burst-${run}`;
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [burstOrg]);
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [
				`m-${burstOrg}`,
				burstOrg,
				user,
			]);
			const burst = await Promise.allSettled(
				Array.from({ length: 7 }, (_, n) => add(`burst${n}.acme.example.test`, asUser(user, burstOrg))),
			);
			expect(burst.filter((result) => result.status === "fulfilled")).toHaveLength(5);
			await owner.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [[org, burstOrg]]);
		});
	});

	describe("one hostname, one owner: concurrent claims", () => {
		const open = async (org: string) => {
			const client = await app.connect();
			await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [org]);
			return client;
		};
		const claim = (client: PoolClient, org: string, hostname: string) =>
			client.query(`SELECT careeros_claim_org_domain($1, $2, $3, 'tok', $4)`, [org, randomUUID(), hostname, A.admin]);
		const close = async (client: PoolClient) => {
			await client.query(`SELECT set_config('app.current_org_id', '', false)`).catch(() => undefined);
			client.release();
		};
		const settled = (promise: Promise<unknown>) => {
			const state = { done: false };
			void promise.then(
				() => (state.done = true),
				() => (state.done = true),
			);
			return state;
		};

		it("lets exactly one of two organizations claim a name when both are in flight", async () => {
			const a = await open(A.org);
			const b = await open(B.org);
			try {
				await a.query("BEGIN");
				await b.query("BEGIN");
				await claim(a, A.org, host("race1"));
				const second = claim(b, B.org, host("race1"));
				const state = settled(second);
				// The second claim waits for the first transaction (it holds the hostname lock).
				await new Promise((resolve) => setTimeout(resolve, 300));
				expect(state.done).toBe(false);
				await a.query("COMMIT");
				await expect(second).rejects.toThrow(/hostname_taken/);
				await b.query("ROLLBACK");
			} finally {
				await close(a);
				await close(b);
			}
			expect((await rowByHost(host("race1")))?.organization_id).toBe(A.org);
		});

		it("lets exactly one win when an organization claim races a personal custom domain", async () => {
			const a = await open(A.org);
			const b = await open(B.org);
			try {
				await a.query("BEGIN");
				await b.query("BEGIN");
				await claim(a, A.org, host("race2"));
				const personal = b.query(
					`INSERT INTO custom_domain (organization_id, user_id, hostname, verification_token) VALUES ($1, $2, $3, 't')`,
					[B.org, B.owner, host("race2")],
				);
				const state = settled(personal);
				await new Promise((resolve) => setTimeout(resolve, 300));
				expect(state.done).toBe(false);
				await a.query("COMMIT");
				await expect(personal).rejects.toThrow(/hostname_taken/);
				await b.query("ROLLBACK");
			} finally {
				await close(a);
				await close(b);
			}
			// And the other way round: the personal claim goes first and the organization is refused.
			const a2 = await open(A.org);
			const b2 = await open(B.org);
			try {
				await b2.query("BEGIN");
				await a2.query("BEGIN");
				await b2.query(
					`INSERT INTO custom_domain (organization_id, user_id, hostname, verification_token) VALUES ($1, $2, $3, 't')`,
					[B.org, B.owner, host("race3")],
				);
				const orgClaim = claim(a2, A.org, host("race3"));
				const state = settled(orgClaim);
				await new Promise((resolve) => setTimeout(resolve, 300));
				expect(state.done).toBe(false);
				await b2.query("COMMIT");
				await expect(orgClaim).rejects.toThrow(/hostname_taken/);
				await a2.query("ROLLBACK");
			} finally {
				await close(a2);
				await close(b2);
				await owner.query(`DELETE FROM custom_domain WHERE hostname = ANY($1::text[])`, [[host("race3")]]);
			}
			expect(await rowByHost(host("race3"))).toBeUndefined();
		});

		it("lets exactly one of many parallel claims succeed through the service", async () => {
			const attempts = await Promise.allSettled([
				add(host("race4"), asUser(A.admin, A.org)),
				add(host("race4"), asUser(B.owner, B.org)),
				add(host("race4"), asUser(A.owner, A.org)),
				add(host("race4"), asUser(B.owner, B.org)),
			]);
			expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
			expect(
				await owner.query(`SELECT count(*)::int AS n FROM organization_domain WHERE hostname = $1`, [host("race4")]),
			).toMatchObject({
				rows: [{ n: 1 }],
			});
		});

		it("keeps the global unique index as a backstop for direct inserts", async () => {
			await expect(
				owner.query(
					`INSERT INTO organization_domain (id, organization_id, hostname, verification_token) VALUES ($1, $2, $3, 't')`,
					[randomUUID(), B.org, host("race1")],
				),
			).rejects.toMatchObject({ code: "23505" });
		});
	});

	describe("row-level security", () => {
		it("shows an organization only its own domains, to the service and to SQL", async () => {
			await add(host("rls-a"));
			const b = await add(host("rls-b"), asUser(B.owner, B.org));
			const listedA = (await list()).map((domain) => domain.hostname);
			expect(listedA).toContain(host("rls-a"));
			expect(listedA).not.toContain(host("rls-b"));
			expect((await list(asUser(B.owner, B.org))).map((domain) => domain.hostname)).toEqual([host("rls-b")]);
			// No context: nothing. Another organization's context: only its own rows. Forged rows are refused.
			expect((await app.query(`SELECT count(*)::int AS n FROM organization_domain`)).rows[0].n).toBe(0);
			const client = await app.connect();
			try {
				await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [B.org]);
				const seen = await client.query(`SELECT hostname FROM organization_domain`);
				expect(seen.rows.map((r: { hostname: string }) => r.hostname)).toEqual([host("rls-b")]);
				await expect(
					client.query(`UPDATE organization_domain SET status = 'failed' WHERE hostname = $1`, [host("rls-a")]),
				).resolves.toMatchObject({ rowCount: 0 });
				await expect(
					client.query(`DELETE FROM organization_domain WHERE hostname = $1`, [host("rls-a")]),
				).resolves.toMatchObject({
					rowCount: 0,
				});
				await expect(
					client.query(
						`INSERT INTO organization_domain (id, organization_id, hostname, verification_token) VALUES ('x', $1, 'forged.acme.example.test', 't')`,
						[A.org],
					),
				).rejects.toMatchObject({ code: "42501" });
			} finally {
				await client.query(`SELECT set_config('app.current_org_id', '', false)`);
				client.release();
			}
			expect(b.id).toBeTruthy();
		});

		it("answers NOT_FOUND to another organization's domain id on recheck and remove, and changes nothing", async () => {
			const idA = (await add(host("rls-c"))).id;
			const before = await row(idA);
			const other = asUser(B.owner, B.org);
			await expect(recheck(idA, other)).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(remove(idA, other)).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(recheck(randomUUID(), other)).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(await row(idA)).toEqual(before);
			expect(fake.requests).toHaveLength(0);
		});
	});

	describe("host lookup and the open-signup function", () => {
		it("resolves only ACTIVE domains, through the definer function as the app role without a context", async () => {
			const id = (await add(host("only-active"))).id;
			for (const status of ["pending", "verified", "failed", "removing"]) {
				await owner.query(`UPDATE organization_domain SET status = $2 WHERE id = $1`, [id, status]);
				expect(await resolvesTo(host("only-active")), status).toBeUndefined();
				expect(
					(await app.query(`SELECT careeros_org_domain_is_registered($1) AS r`, [host("only-active")])).rows[0].r,
				).toBe(true);
			}
			await owner.query(`UPDATE organization_domain SET status = 'active' WHERE id = $1`, [id]);
			expect(await resolvesTo(host("only-active"))).toBe(A.org);
			expect(
				(await app.query(`SELECT slug FROM careeros_org_for_custom_host($1)`, [host("ONLY-ACTIVE")])).rows,
			).toEqual([{ slug: A.org }]);
			expect(await resolvesTo("unregistered.acme.example.test")).toBeUndefined();
			expect(
				(await app.query(`SELECT careeros_org_domain_is_registered('unregistered.acme.example.test') AS r`)).rows[0].r,
			).toBe(false);
			await owner.query(`UPDATE organization_domain SET status = 'pending' WHERE id = $1`, [id]);
		});

		it("careeros_org_open_signup answers the organization's setting, and false for an unknown one", async () => {
			const open = async (org: string) =>
				(await app.query(`SELECT careeros_org_open_signup($1) AS open`, [org])).rows[0].open as boolean;
			expect(await open(A.org)).toBe(false);
			await owner.query(`UPDATE organization_settings SET open_signup = true WHERE organization_id = $1`, [A.org]);
			expect(await open(A.org)).toBe(true);
			expect(await open(B.org)).toBe(false);
			expect(await open("no-such-org")).toBe(false);
			await owner.query(`UPDATE organization_settings SET open_signup = false WHERE organization_id = $1`, [A.org]);
		});

		it("is executable by careeros_app and by no one else (not PUBLIC)", async () => {
			const functions = [
				"careeros_org_open_signup(text)",
				"careeros_org_for_custom_host(text)",
				"careeros_org_domain_is_registered(text)",
				"careeros_org_domains_due(integer)",
				"careeros_claim_org_domain(text, text, text, text, text, text[], text, text)",
				"careeros_custom_domain_guard()",
				"careeros_org_domain_cf_cleanup_enqueue()",
			];
			for (const signature of functions) {
				const { rows } = await owner.query(
					`SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
					   WHERE p.oid = $1::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_can`,
					[`public.${signature}`],
				);
				expect(rows[0].public_can, signature).toBe(false);
			}
			// A role with no grant is refused outright.
			await owner.query(`DROP ROLE IF EXISTS iso_nobody_${run}`);
			await owner.query(`CREATE ROLE iso_nobody_${run} NOLOGIN`);
			const client = await owner.connect();
			try {
				await client.query(`SET ROLE iso_nobody_${run}`);
				await expect(client.query(`SELECT careeros_org_open_signup('x')`)).rejects.toMatchObject({ code: "42501" });
				await expect(client.query(`SELECT * FROM careeros_org_for_custom_host('x.test')`)).rejects.toMatchObject({
					code: "42501",
				});
				await client.query(`RESET ROLE`);
			} finally {
				client.release();
			}
			await owner.query(`DROP ROLE iso_nobody_${run}`);
			for (const signature of functions.slice(0, 5))
				expect(
					(
						await owner.query(
							`SELECT has_function_precedure_privilege FROM (SELECT has_function_privilege('careeros_app', $1::regprocedure, 'EXECUTE') AS has_function_precedure_privilege) t`,
							[`public.${signature}`],
						)
					).rows[0].has_function_precedure_privilege,
					signature,
				).toBe(true);
		});

		it("resolves an active domain to its organization and everything else fails closed, with a cache that follows status changes", async () => {
			const id = await activate(host("live"));
			const resolver = tenancy.createHostResolver({
				platformHosts: new Set(["localhost"]),
				orgHostPattern: "{slug}-orgs.example.test",
				lookupBySlug: async () => null,
				customDomainOrg: (hostname) => inApp(() => tenancy.lookupOrgByCustomHost(hostname)),
			});
			tenancy.setHostResolverForTesting(resolver);
			const at = (hostname: string) => new Request(`https://${hostname}/`, { headers: { host: hostname } });

			await expect(resolver(at(host("live")))).resolves.toMatchObject({
				kind: "org",
				organizationId: A.org,
				via: "custom",
				hostname: host("live"),
			});
			await expect(tenancy.hostTrustedOrigins(at(host("live")))).resolves.toEqual([`https://${host("live")}`]);

			// Removal stops resolution at once (the cache is dropped), long before the 60 s TTL. With the Cloudflare delete
			// failing the row stays `removing`: the host is still held, so it is a 404 and never the platform's rules.
			fake.failures.push({ match: (r) => r.method === "DELETE", status: 500, times: 1 });
			await remove(id);
			expect((await row(id))?.status).toBe("removing");
			const removing = await resolver(at(host("live")));
			expect(removing).toEqual({ kind: "unknown", matchesOrgPattern: true });
			await expect(
				inApp(() => tenancy.resolveOrgForAuthentication({ method: "session", user: { id: A.admin } }, removing)),
			).rejects.toMatchObject({ code: "unknown_org_host" });
			// Once the row is gone the name is free and behaves like any other unknown host.
			await makeDue(id);
			await runJobs();
			expect(await row(id)).toBeUndefined();
			await expect(resolver(at(host("live")))).resolves.toEqual({ kind: "unknown", matchesOrgPattern: false });
			await expect(resolver(at("never-added.acme.example.test"))).resolves.toEqual({
				kind: "unknown",
				matchesOrgPattern: false,
			});
		});

		it("never trusts the origin of a pending, verified, failed or removing domain", async () => {
			const resolver = tenancy.createHostResolver({
				platformHosts: new Set(["localhost"]),
				orgHostPattern: "{slug}-orgs.example.test",
				lookupBySlug: async () => null,
				customDomainOrg: (hostname) => inApp(() => tenancy.lookupOrgByCustomHost(hostname)),
				ttlMs: 0,
			});
			tenancy.setHostResolverForTesting(resolver);
			const id = (await add(host("trust-me"))).id;
			for (const status of ["pending", "verified", "failed", "removing"]) {
				await owner.query(`UPDATE organization_domain SET status = $2 WHERE id = $1`, [id, status]);
				const request = new Request(`https://${host("trust-me")}/`, { headers: { host: host("trust-me") } });
				await expect(
					inApp(() => tenancy.hostTrustedOrigins(request)),
					status,
				).resolves.toEqual([]);
				await expect(resolver(request), status).resolves.toEqual({ kind: "unknown", matchesOrgPattern: true });
			}
			await owner.query(`UPDATE organization_domain SET status = 'active' WHERE id = $1`, [id]);
			const request = new Request(`https://${host("trust-me")}/`, { headers: { host: host("trust-me") } });
			await expect(inApp(() => tenancy.hostTrustedOrigins(request))).resolves.toEqual([`https://${host("trust-me")}`]);
			await owner.query(`UPDATE organization_domain SET status = 'pending' WHERE id = $1`, [id]);
		});
	});

	describe("the status machine", () => {
		it("moves pending to verified to active, calling Cloudflare once the TXT proves ownership", async () => {
			const created = await add(host("flow"));
			const token = String((await row(created.id))?.verification_token);

			// No proof yet: nothing happens, and Cloudflare is not called.
			await runJobs();
			expect((await row(created.id))?.status).toBe("pending");
			expect(fake.requests).toHaveLength(0);
			expect(txtChecks.at(-1)).toEqual({ hostname: host("flow"), token });

			// Not due again for five minutes.
			txtChecks.length = 0;
			await runJobs();
			expect(txtChecks).toHaveLength(0);

			// The proof appears: verified, registered at Cloudflare with HTTP validation, id stored.
			txtAnswers.set(host("flow"), "proved");
			await makeDue(created.id);
			await runJobs();
			const verified = await row(created.id);
			expect(verified).toMatchObject({ status: "verified", cf_ssl_status: "pending_validation", txt_missing_count: 0 });
			expect(verified?.verified_at).not.toBeNull();
			expect(verified?.cf_custom_hostname_id).toBe(fake.find(host("flow"))?.id);
			expect(fake.calls("POST")).toHaveLength(1);
			expect(fake.calls("POST")[0]?.body).toEqual({ hostname: host("flow"), ssl: { method: "http", type: "dv" } });
			expect(await resolvesTo(host("flow"))).toBeUndefined();

			// Cloudflare is still issuing: it stays verified and follows the certificate status.
			fake.setStatus(host("flow"), "pending", "pending_deployment");
			await makeDue(created.id);
			await runJobs();
			expect(await row(created.id)).toMatchObject({ status: "verified", cf_ssl_status: "pending_deployment" });
			expect(await resolvesTo(host("flow"))).toBeUndefined();

			// The hostname alone being active is not enough: the certificate must be too.
			fake.setStatus(host("flow"), "active", "pending_deployment");
			await makeDue(created.id);
			await runJobs();
			expect((await row(created.id))?.status).toBe("verified");

			fake.setStatus(host("flow"), "active", "active");
			await makeDue(created.id);
			await runJobs();
			expect(await row(created.id)).toMatchObject({ status: "active", cf_ssl_status: "active" });
			expect(await resolvesTo(host("flow"))).toBe(A.org);
			expect(fake.calls("POST")).toHaveLength(1);
		});

		it("fails a domain stuck in pending for seven days with verification_timeout, and it stops being checked", async () => {
			const created = await add(host("stale"));
			await age(created.id, "created_at", "8 days");
			await runJobs();
			expect(await row(created.id)).toMatchObject({ status: "failed", failure_reason: "verification_timeout" });
			expect(await resolvesTo(host("stale"))).toBeUndefined();
			txtChecks.length = 0;
			await makeDue(created.id);
			await runJobs();
			expect(txtChecks.filter((check) => check.hostname === host("stale"))).toHaveLength(0);
			// Six days old is not stale yet.
			const fresh = await add(host("almost"));
			await age(fresh.id, "created_at", "6 days");
			await runJobs();
			expect((await row(fresh.id))?.status).toBe("pending");
		});

		it("fails a verified domain that Cloudflare refuses or whose certificate times out", async () => {
			for (const [label, status, ssl] of [
				["blocked", "blocked", "pending_validation"],
				["sslout", "pending", "validation_timed_out"],
			] as const) {
				const id = (await add(host(label))).id;
				txtAnswers.set(host(label), "proved");
				await runJobs();
				fake.setStatus(host(label), status, ssl);
				await makeDue(id);
				await runJobs();
				expect(await row(id), label).toMatchObject({ status: "failed", failure_reason: "cloudflare_rejected" });
				expect(await resolvesTo(host(label))).toBeUndefined();
			}
		});

		it("recreates the Cloudflare hostname when it vanished before becoming active, and adopts one a crash left behind", async () => {
			const id = (await add(host("gone"))).id;
			txtAnswers.set(host("gone"), "proved");
			await runJobs();
			const first = fake.find(host("gone"))?.id as string;
			fake.hosts.delete(first);
			await makeDue(id);
			await runJobs();
			expect(await row(id)).toMatchObject({ status: "verified", cf_custom_hostname_id: null });
			await makeDue(id);
			await runJobs();
			expect((await row(id))?.cf_custom_hostname_id).toBe(fake.find(host("gone"))?.id);
			expect(fake.find(host("gone"))?.id).not.toBe(first);

			// A hostname that exists in the zone but that we never stored: adopted, not an endless duplicate error.
			const orphan = (await add(host("orphan"))).id;
			await fake.fetch(`https://x/zones/z/custom_hostnames`, {
				method: "POST",
				body: JSON.stringify({ hostname: host("orphan") }),
			});
			txtAnswers.set(host("orphan"), "proved");
			await runJobs();
			expect((await row(orphan))?.cf_custom_hostname_id).toBe(fake.find(host("orphan"))?.id);
		});

		it("keeps a verified domain verified and retries when Cloudflare is down, without failing it", async () => {
			const id = (await add(host("flaky"))).id;
			txtAnswers.set(host("flaky"), "proved");
			fake.failures.push({ match: (r) => r.method === "POST", status: 500, times: 1 });
			await runJobs();
			expect(await row(id)).toMatchObject({ status: "verified", cf_custom_hostname_id: null });
			await makeDue(id);
			await runJobs();
			expect((await row(id))?.cf_custom_hostname_id).toBe(fake.find(host("flaky"))?.id);
		});

		describe("the takeover guard", () => {
			it("fails an active domain after the TXT record is missing on 3 daily checks in a row, and it stops resolving", async () => {
				const id = await activate(host("guard"));
				expect(await resolvesTo(host("guard"))).toBe(A.org);
				txtAnswers.set(host("guard"), "missing");
				for (const expected of [1, 2]) {
					await makeDailyDue(id);
					await runJobs();
					expect(await row(id), `check ${expected}`).toMatchObject({ status: "active", txt_missing_count: expected });
					expect(await resolvesTo(host("guard"))).toBe(A.org);
				}
				await makeDailyDue(id);
				await runJobs();
				expect(await row(id)).toMatchObject({ status: "failed", failure_reason: "txt_missing", txt_missing_count: 3 });
				expect(await resolvesTo(host("guard"))).toBeUndefined();
			});

			it("resets the count when the record comes back, and ignores a lookup that failed", async () => {
				const id = await activate(host("guard2"));
				txtAnswers.set(host("guard2"), "missing");
				for (let n = 0; n < 2; n++) {
					await makeDailyDue(id);
					await runJobs();
				}
				expect((await row(id))?.txt_missing_count).toBe(2);
				// A timeout or SERVFAIL says nothing about the record.
				txtAnswers.set(host("guard2"), "unknown");
				await makeDailyDue(id);
				await runJobs();
				expect(await row(id)).toMatchObject({ status: "active", txt_missing_count: 2 });
				txtAnswers.set(host("guard2"), "proved");
				await makeDailyDue(id);
				await runJobs();
				expect(await row(id)).toMatchObject({ status: "active", txt_missing_count: 0 });
				// Two more misses are fine again.
				txtAnswers.set(host("guard2"), "missing");
				for (let n = 0; n < 2; n++) {
					await makeDailyDue(id);
					await runJobs();
				}
				expect((await row(id))?.status).toBe("active");
			});

			it("checks an active domain once a day, not every five minutes", async () => {
				const id = await activate(host("guard3"));
				txtChecks.length = 0;
				await makeDue(id);
				await runJobs();
				expect(txtChecks.filter((check) => check.hostname === host("guard3"))).toHaveLength(0);
				await makeDailyDue(id);
				await runJobs();
				expect(txtChecks.filter((check) => check.hostname === host("guard3"))).toHaveLength(1);
			});

			it("fails an active domain Cloudflare reports moved, deleted or blocked, and one it no longer knows", async () => {
				for (const [label, status, reason] of [
					["moved", "moved", "cloudflare_moved"],
					["blocked2", "blocked", "cloudflare_rejected"],
					["deleted", "deleted", "cloudflare_rejected"],
				] as const) {
					const id = await activate(host(label));
					txtAnswers.set(host(label), "proved");
					fake.setStatus(host(label), status, "active");
					await makeDailyDue(id);
					await runJobs();
					expect(await row(id), label).toMatchObject({ status: "failed", failure_reason: reason });
					expect(await resolvesTo(host(label))).toBeUndefined();
				}
				const id = await activate(host("vanished"));
				txtAnswers.set(host("vanished"), "proved");
				fake.hosts.delete(String((await row(id))?.cf_custom_hostname_id));
				await makeDailyDue(id);
				await runJobs();
				expect(await row(id)).toMatchObject({ status: "failed", failure_reason: "cloudflare_deleted" });
			});

			it("keeps an active domain when Cloudflare cannot be reached for a check", async () => {
				const id = await activate(host("guard4"));
				txtAnswers.set(host("guard4"), "proved");
				fake.failures.push({ match: () => true, status: 503, times: 5 });
				await makeDailyDue(id);
				await runJobs();
				expect((await row(id))?.status).toBe("active");
				expect(await resolvesTo(host("guard4"))).toBe(A.org);
			});
		});

		describe("removal", () => {
			it("stops resolving at once, deletes the hostname at Cloudflare, then the row", async () => {
				const id = await activate(host("bye"));
				const cfId = String((await row(id))?.cf_custom_hostname_id);
				await remove(id);
				expect(await row(id)).toBeUndefined();
				expect(fake.hosts.has(cfId)).toBe(false);
				expect(await resolvesTo(host("bye"))).toBeUndefined();
				// The name is free again for any organization.
				await expect(add(host("bye"), asUser(B.owner, B.org))).resolves.toMatchObject({ status: "pending" });
				// A normal removal queues no Cloudflare cleanup.
				expect(
					(
						await owner.query(
							`SELECT count(*)::int AS n FROM organization_domain_cf_cleanup WHERE cf_custom_hostname_id = $1`,
							[cfId],
						)
					).rows[0].n,
				).toBe(0);
			});

			it("keeps the row in removing, not resolving, when the Cloudflare delete fails, and the job retries it", async () => {
				const id = await activate(host("stuck"));
				const cfId = String((await row(id))?.cf_custom_hostname_id);
				fake.failures.push({ match: (r) => r.method === "DELETE", status: 500, times: 1 });
				await remove(id);
				expect(await row(id)).toMatchObject({ status: "removing", cf_custom_hostname_id: cfId });
				expect(fake.hosts.has(cfId)).toBe(true);
				expect(await resolvesTo(host("stuck"))).toBeUndefined();
				// The name stays claimed until Cloudflare is clean.
				await expect(add(host("stuck"), asUser(B.owner, B.org))).rejects.toMatchObject({ code: "CONFLICT" });
				await expect(recheck(id)).rejects.toMatchObject({ code: "CONFLICT" });

				await runJobs();
				expect(await row(id)).toMatchObject({ status: "removing" });
				await makeDue(id);
				await runJobs();
				expect(await row(id)).toBeUndefined();
				expect(fake.hosts.has(cfId)).toBe(false);
			});

			it("counts a hostname Cloudflare already deleted as deleted", async () => {
				const id = await activate(host("already"));
				fake.hosts.delete(String((await row(id))?.cf_custom_hostname_id));
				await remove(id);
				expect(await row(id)).toBeUndefined();
			});

			it("removes a pending domain without calling Cloudflare", async () => {
				const id = (await add(host("never"))).id;
				fake.requests.length = 0;
				await remove(id);
				expect(await row(id)).toBeUndefined();
				expect(fake.requests).toHaveLength(0);
			});

			it("does not let a check bring a domain back that was removed during it", async () => {
				const id = (await add(host("racing"))).id;
				txtAnswers.set(host("racing"), "proved");
				// The removal lands while the job is registering the hostname at Cloudflare.
				const originalFetch = fake.fetch;
				let removed = false;
				fake.fetch = async (input, init) => {
					const response = await originalFetch(input, init);
					if (init?.method === "POST" && !removed) {
						removed = true;
						await owner.query(`UPDATE organization_domain SET status = 'removing' WHERE id = $1`, [id]);
					}
					return response;
				};
				vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => fake.fetch(input, init));
				await runJobs();
				// The hostname registered a moment ago is not left behind in the zone.
				expect(fake.find(host("racing"))).toBeUndefined();
				expect(await row(id)).toMatchObject({ status: "removing", cf_custom_hostname_id: null });
				await makeDue(id);
				await runJobs();
				expect(await row(id)).toBeUndefined();
			});
		});

		describe("deleting an organization", () => {
			it("queues the Cloudflare hostnames of its domains, and the job deletes them", async () => {
				const org = `dom-del-${run}`;
				const user = `dom-del-user-${run}`;
				await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
				await owner.query(
					`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
					[user],
				);
				await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $1, 'owner')`, [
					user,
					org,
				]);
				const context = asUser(user, org);
				const active = await activate(host("deladmin"), context);
				const pending = (await add(host("delpending"), context)).id;
				const cfId = String((await row(active))?.cf_custom_hostname_id);
				await owner.query(`DELETE FROM organization WHERE id = $1`, [org]);
				expect(await row(active)).toBeUndefined();
				expect(await row(pending)).toBeUndefined();
				// Only the row that named a Cloudflare hostname is queued.
				const queued = await owner.query(`SELECT cf_custom_hostname_id, hostname FROM organization_domain_cf_cleanup`);
				expect(queued.rows).toEqual([{ cf_custom_hostname_id: cfId, hostname: host("deladmin") }]);

				// A failed delete backs off and keeps the entry; the next try deletes it.
				fake.failures.push({ match: (r) => r.method === "DELETE", status: 500, times: 1 });
				await runJobs();
				expect(fake.hosts.has(cfId)).toBe(true);
				expect((await owner.query(`SELECT attempts FROM organization_domain_cf_cleanup`)).rows).toEqual([
					{ attempts: 1 },
				]);
				await owner.query(`UPDATE organization_domain_cf_cleanup SET next_attempt_at = now() - interval '1 minute'`);
				await runJobs();
				expect(fake.hosts.has(cfId)).toBe(false);
				expect((await owner.query(`SELECT count(*)::int AS n FROM organization_domain_cf_cleanup`)).rows[0].n).toBe(0);
			});

			it("does not adopt a Cloudflare hostname that is queued for deletion", async () => {
				const stale = await fake.fetch(`https://x/zones/z/custom_hostnames`, {
					method: "POST",
					body: JSON.stringify({ hostname: host("reuse") }),
				});
				const staleId = ((await stale.json()) as { result: { id: string } }).result.id;
				await owner.query(
					`INSERT INTO organization_domain_cf_cleanup (cf_custom_hostname_id, hostname, next_attempt_at) VALUES ($1, $2, now() + interval '1 hour')`,
					[staleId, host("reuse")],
				);
				const id = (await add(host("reuse"), asUser(B.owner, B.org))).id;
				txtAnswers.set(host("reuse"), "proved");
				await runJobs();
				expect(await row(id)).toMatchObject({ status: "verified", cf_custom_hostname_id: null });
				// Once the stale hostname is deleted, the new domain registers its own.
				await owner.query(`UPDATE organization_domain_cf_cleanup SET next_attempt_at = now() - interval '1 minute'`);
				await runJobs();
				expect(fake.hosts.has(staleId)).toBe(false);
				await makeDue(id);
				await runJobs();
				const stored = String((await row(id))?.cf_custom_hostname_id);
				expect(stored).not.toBe(staleId);
				expect(fake.hosts.has(stored)).toBe(true);
			});
		});

		describe("recheck", () => {
			it("checks now, at most once a minute per domain", async () => {
				const created = await add(host("manual"));
				txtAnswers.set(host("manual"), "proved");
				const first = await recheck(created.id);
				expect(first.status).toBe("verified");
				await expect(recheck(created.id)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
				await age(created.id, "last_checked_at", "61 seconds");
				fake.setStatus(host("manual"), "active", "active");
				await expect(recheck(created.id)).resolves.toMatchObject({ status: "active" });
				// Another domain is not held up by this one's limit.
				const other = await add(host("manual2"));
				await expect(recheck(other.id)).resolves.toMatchObject({ status: "pending" });
			});

			it("refuses a failed domain, and an unknown id", async () => {
				const created = await add(host("manualfail"));
				await owner.query(`UPDATE organization_domain SET status = 'failed' WHERE id = $1`, [created.id]);
				await expect(recheck(created.id)).rejects.toMatchObject({ code: "CONFLICT", data: { code: "DOMAIN_FAILED" } });
				await expect(recheck(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
			});

			it("does not count TXT checks of an active domain: only the daily cadence can fail it", async () => {
				const id = await activate(host("manual3"));
				txtAnswers.set(host("manual3"), "missing");
				for (let n = 0; n < 4; n++) {
					await age(id, "last_checked_at", "2 minutes");
					await recheck(id);
				}
				expect(await row(id)).toMatchObject({ status: "active", txt_missing_count: 0 });
			});
		});

		describe("the polling job", () => {
			it("takes a domain once when two passes race for it", async () => {
				const id = (await add(host("lease"))).id;
				txtAnswers.set(host("lease"), "missing");
				const results = await Promise.all([
					inApp(() => process_.checkDomain(A.org, id, "job", deps())),
					inApp(() => process_.checkDomain(A.org, id, "job", deps())),
					inApp(() => process_.checkDomain(A.org, id, "job", deps())),
				]);
				expect(results.filter((result) => result.leased)).toHaveLength(1);
			});

			it("works through at most 20 due domains a pass, and the rest on the next one", async () => {
				// 25 pending domains across 5 organizations (five each), all never checked.
				await owner.query(
					`UPDATE organization_domain SET last_checked_at = now() WHERE status IN ('pending','verified','removing','active')`,
				);
				const orgs = Array.from({ length: 5 }, (_, n) => `dom-batch-${n}-${run}`);
				for (const org of orgs) {
					await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
					for (let n = 0; n < 5; n++)
						await owner.query(
							`INSERT INTO organization_domain (id, organization_id, hostname, verification_token) VALUES ($1, $2, $3, 't')`,
							[randomUUID(), org, `b${n}.${org}.example.test`],
						);
				}
				const first = await runJobs();
				expect(first.checked).toBe(20);
				const second = await runJobs();
				expect(second.checked).toBe(5);
				await owner.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [orgs]);
			});

			it("does nothing, and never calls Cloudflare, when Cloudflare for SaaS is not configured", async () => {
				const id = (await add(host("unconfigured"))).id;
				txtAnswers.set(host("unconfigured"), "proved");
				fake.requests.length = 0;
				await expect(inApp(() => jobs.runOrgDomainJobs(deps(false)))).resolves.toEqual({
					checked: 0,
					failed: 0,
					cleaned: 0,
				});
				expect((await row(id))?.status).toBe("pending");
				expect(fake.requests).toHaveLength(0);
			});

			it("logs one failing domain and keeps going", async () => {
				const bad = (await add(host("badone"))).id;
				const good = (await add(host("goodone"))).id;
				txtAnswers.set(host("goodone"), "proved");
				const base = deps();
				const summary = await inApp(() =>
					jobs.runOrgDomainJobs({
						...base,
						checkTxt: async (hostname, token) => {
							if (hostname === host("badone")) throw new Error(`boom ${TOKEN} secret-driver-detail`);
							return base.checkTxt(hostname, token);
						},
					}),
				);
				expect(summary.failed).toBeGreaterThanOrEqual(1);
				expect((await row(good))?.status).toBe("verified");
				expect((await row(bad))?.status).toBe("pending");
				const text = logs.join("\n");
				expect(text).toContain("Check failed");
				expect(text).not.toContain("secret-driver-detail");
			});
		});

		it("never writes the Cloudflare token, an Authorization header or a response body to any log", async () => {
			const id = (await add(host("logs"))).id;
			txtAnswers.set(host("logs"), "proved");
			fake.failures.push({
				match: () => true,
				status: 401,
				codes: [10000],
				echo: `Bearer ${TOKEN} rejected`,
				times: 3,
			});
			await runJobs();
			await makeDue(id);
			await runJobs();
			await remove(id);
			const text = logs.join("\n");
			expect(text).toContain("HTTP 401");
			expect(text).not.toContain(TOKEN);
			expect(text).not.toContain("rejected");
			expect(text.toLowerCase()).not.toContain("authorization");
			// The token went out only in the Authorization header of requests to Cloudflare.
			expect(fake.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
			expect(
				fake.requests.every(
					(request) => !request.url.includes(TOKEN) && !JSON.stringify(request.body ?? "").includes(TOKEN),
				),
			).toBe(true);
		});
	});
});
