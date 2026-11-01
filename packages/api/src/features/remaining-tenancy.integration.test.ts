import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { withOrgContext } from "@careeros/tenancy";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { db, withDatabasePool } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

// This suite needs the real organization scope, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());

const dns = vi.hoisted(() => {
	process.env.CUSTOM_DOMAIN_TARGET ??= "domains.example.test";
	process.env.CUSTOM_DOMAIN_PROVIDER_SECRET ??= "p".repeat(32);
	process.env.ENCRYPTION_SECRET ??= "integration-test-encryption-secret-32-chars";
	// The TXT proof every host publishes in this suite: the tokens are looked up from the rows themselves.
	return { tokens: new Set<string>() };
});
vi.mock("node:dns/promises", () => ({
	resolveTxt: async () => [...dns.tokens].map((token) => [`rx-verify=${token}`]),
	resolveCname: async () => [process.env.CUSTOM_DOMAIN_TARGET ?? ""],
	resolve4: async () => [],
	resolve6: async () => [],
}));

// P1-T09: custom_domain, storage_cleanup_job and web_access_credentials behind row-level security, as the
// `careeros_app` role (NOBYPASSRLS), against the migrated public schema. Skipped only when the CAREEROS_TEST_*
// variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("remaining tables and tenant isolation", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `rem-a-${run}`,
		orgB: `rem-b-${run}`,
		// Not a valid organization id for withOrgContext, so that organization's work fails as a whole.
		orgBad: `rem bad ${run}`,
		userA: `rem-user-a-${run}`,
		userB: `rem-user-b-${run}`,
		userBad: `rem-user-bad-${run}`,
		role: `t09_noexec_${run}`,
	};
	const hostA = `a-${run}.example.test`;
	let owner: Pool;
	let app: Pool;
	const inApp = <T>(fn: () => T) => withDatabasePool(app, fn);
	const count = async (sql: string, params: unknown[] = []) =>
		Number((await owner.query<{ n: string }>(sql, params)).rows[0]?.n);
	const store = new Map<string, "ok" | "fail">();

	beforeAll(async () => {
		owner = new Pool({ connectionString: process.env.CAREEROS_TEST_DATABASE_URL });
		app = new Pool({ connectionString: process.env.CAREEROS_TEST_APP_DATABASE_URL });
		for (const [org, user] of [
			[ids.orgA, ids.userA],
			[ids.orgB, ids.userB],
			[ids.orgBad, ids.userBad],
		] as const) {
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[user],
			);
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [
				`m-${user}`,
				org,
				user,
			]);
		}
		await owner.query(`CREATE ROLE "${ids.role}" NOLOGIN`);
		// Storage: a prefix is "ok" (deletes) or "fail" (throws).
		const { configureStorageService } = await import("./storage/service");
		configureStorageService({
			list: async (prefix: string) => [...store.keys()].filter((key) => key === prefix),
			read: async () => null,
			write: async () => undefined,
			delete: async (prefix: string) => {
				if (store.get(prefix) === "fail") throw new Error("storage unavailable");
				return store.delete(prefix);
			},
			healthcheck: async () => ({ status: "healthy", type: "local", message: "Synthetic storage" }),
		} as never);
	});

	afterAll(async () => {
		await owner?.query(`DELETE FROM organization WHERE id = ANY($1::text[])`, [[ids.orgA, ids.orgB, ids.orgBad]]);
		await owner?.query(`DELETE FROM storage_cleanup_job WHERE id LIKE $1`, [`%${run}%`]);
		await owner?.query(`DELETE FROM "user" WHERE id LIKE $1`, [`%${run}%`]);
		await owner?.query(`DROP ROLE IF EXISTS "${ids.role}"`);
		await owner?.end();
		await app?.end();
	});

	it("hides all three tables from careeros_app without an organization context", async () => {
		await owner.query(
			`INSERT INTO custom_domain (organization_id, user_id, hostname, verification_token) VALUES ($1, $2, $3, 'seed-token')`,
			[ids.orgA, ids.userA, `seed-${hostA}`],
		);
		await owner.query(
			`INSERT INTO web_access_credentials (organization_id, user_id, provider, encrypted_api_key) VALUES ($1, $2, 'exa', 'x')`,
			[ids.orgA, ids.userA],
		);
		await owner.query(
			`INSERT INTO storage_cleanup_job (id, organization_id, owner_id, storage_key) VALUES ($1, $2, $3, 'uploads/x')`,
			[`seed-job-${run}`, ids.orgA, ids.userA],
		);
		for (const table of ["custom_domain", "web_access_credentials", "storage_cleanup_job"]) {
			expect((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
			await expect(app.query(`DELETE FROM ${table}`)).resolves.toMatchObject({ rowCount: 0 });
		}
		await owner.query(`DELETE FROM custom_domain WHERE organization_id = $1`, [ids.orgA]);
		await owner.query(`DELETE FROM web_access_credentials WHERE organization_id = $1`, [ids.orgA]);
		await owner.query(`DELETE FROM storage_cleanup_job WHERE id = $1`, [`seed-job-${run}`]);
	});

	describe("custom domains", () => {
		it("keeps each organization's domain apart and resolves a verified one publicly without a context", async () => {
			const { customDomainService, customDomainUsername, traefikConfiguration } =
				await import("./custom-domain/service");
			const statusA = await inApp(() =>
				withOrgContext(ids.orgA, async () => {
					const status = await customDomainService.set(ids.userA, hostA);
					dns.tokens.add(status.txtValue.replace("rx-verify=", ""));
					return customDomainService.verify(ids.userA);
				}),
			);
			expect(statusA.verified).toBe(true);
			// The organization column is stored but never in the output.
			expect(JSON.stringify(statusA)).not.toContain(ids.orgA);
			expect(await count(`SELECT count(*) AS n FROM custom_domain WHERE organization_id = $1`, [ids.orgA])).toBe(1);

			// Another organization sees nothing of it, even asking for the same user id.
			expect(await inApp(() => withOrgContext(ids.orgB, () => customDomainService.get(ids.userA)))).toBeNull();

			// Public lookup: no context at all.
			expect(await inApp(() => customDomainUsername(hostA.toUpperCase()))).toBe(ids.userA);
			expect(await inApp(() => customDomainUsername(`unknown-${hostA}`))).toBeNull();
			const traefik = await inApp(() =>
				traefikConfiguration({ service: "app@x", entryPoint: "websecure", certResolver: "le" }),
			);
			expect(JSON.stringify(traefik)).toContain(hostA);
			const owners = await app.query(`SELECT * FROM careeros_public_domain_owner($1)`, [hostA]);
			expect(owners.rows).toEqual([{ user_id: ids.userA, organization_id: ids.orgA }]);
			const column = await app.query(`SELECT careeros_public_verified_domain($1) AS host`, [ids.userA]);
			expect(column.rows[0].host).toBe(hostA);
		});

		it("moves a hostname to the organization that proves it, through the global unique index", async () => {
			const { customDomainService, customDomainUsername } = await import("./custom-domain/service");
			const statusB = await inApp(() =>
				withOrgContext(ids.orgB, async () => {
					const status = await customDomainService.set(ids.userB, hostA);
					dns.tokens.add(status.txtValue.replace("rx-verify=", ""));
					return customDomainService.verify(ids.userB);
				}),
			);
			expect(statusB.verified).toBe(true);
			expect(await inApp(() => customDomainUsername(hostA))).toBe(ids.userB);
			expect(
				await count(`SELECT count(*) AS n FROM custom_domain WHERE hostname = $1 AND verified_at IS NOT NULL`, [hostA]),
			).toBe(1);
			expect(
				await count(
					`SELECT count(*) AS n FROM custom_domain WHERE organization_id = $1 AND user_id = $2 AND verified_at IS NULL`,
					[ids.orgA, ids.userA],
				),
			).toBe(1);
		});

		it("refuses to release claims for an organization other than the current one", async () => {
			const client = await app.connect();
			try {
				await client.query("select set_config('app.current_org_id', $1, false)", [ids.orgA]);
				await expect(
					client.query(`SELECT careeros_release_domain_claims($1, $2, $3)`, [hostA, ids.orgB, ids.userB]),
				).rejects.toThrow(/not the current one/);
			} finally {
				client.release(true);
			}
		});

		it("refuses to release other claimants when the caller holds no claim, leaving them verified", async () => {
			// hostA is verified by orgB's user (previous test). orgA has no claim on it any more under this hostname.
			await owner.query(`UPDATE custom_domain SET hostname = $2 WHERE organization_id = $1`, [
				ids.orgA,
				`other-${hostA}`,
			]);
			const client = await app.connect();
			try {
				await client.query("select set_config('app.current_org_id', $1, false)", [ids.orgA]);
				await expect(
					client.query(`SELECT careeros_release_domain_claims($1, $2, $3)`, [hostA, ids.orgA, ids.userA]),
				).rejects.toThrow(/holds no claim/);
			} finally {
				client.release(true);
			}
			expect(
				await count(
					`SELECT count(*) AS n FROM custom_domain WHERE hostname = $1 AND verified_at IS NOT NULL AND organization_id = $2`,
					[hostA, ids.orgB],
				),
			).toBe(1);
		});

		it("re-checks every due domain once per organization and survives one organization failing", async () => {
			const { recheckStaleDomains } = await import("./custom-domain/service");
			const hostBad = `bad-${run}.example.test`;
			const hostA2 = `a2-${run}.example.test`;
			const old = "date_trunc('milliseconds', now() - interval '3 days')";
			// orgB's domain from the previous test is verified; orgA's is made verified again, and the failing organization added.
			await owner.query(`UPDATE custom_domain SET last_checked_at = ${old} WHERE organization_id = $1`, [ids.orgB]);
			await owner.query(
				`UPDATE custom_domain SET hostname = $2, verification_token = 'tok-a2', verified_at = now(), last_checked_at = ${old} WHERE organization_id = $1`,
				[ids.orgA, hostA2],
			);
			await owner.query(
				`INSERT INTO custom_domain (organization_id, user_id, hostname, verification_token, verified_at, last_checked_at)
				 VALUES ($1, $2, $3, 'tok-bad', now(), ${old})`,
				[ids.orgBad, ids.userBad, hostBad],
			);
			// The stale list answers with (user, organization) pairs only.
			const pairs = await app.query(`SELECT * FROM careeros_stale_custom_domains(now() - interval '1 day', 50)`);
			expect(pairs.rows).toEqual(
				expect.arrayContaining([
					{ user_id: ids.userB, organization_id: ids.orgB },
					{ user_id: ids.userA, organization_id: ids.orgA },
					{ user_id: ids.userBad, organization_id: ids.orgBad },
				]),
			);
			dns.tokens.add("tok-a2");
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
			await inApp(() => recheckStaleDomains());
			expect(error).toHaveBeenCalled();
			error.mockRestore();
			const checked = (org: string) =>
				count(
					`SELECT count(*) AS n FROM custom_domain WHERE organization_id = $1 AND last_checked_at > now() - interval '1 day'`,
					[org],
				);
			expect(await checked(ids.orgB)).toBe(1);
			expect(await checked(ids.orgA)).toBe(1);
			expect(await checked(ids.orgBad), "the failing organization is left for a later tick").toBe(0);
		});
	});

	describe("web access credentials", () => {
		it("saves per organization and shows nothing of another organization's connection", async () => {
			const { webAccessService } = await import("./web-access/credentials");
			await inApp(() => withOrgContext(ids.orgA, () => webAccessService.save(ids.userA, "exa", "key-a")));
			expect(
				await count(`SELECT count(*) AS n FROM web_access_credentials WHERE organization_id = $1`, [ids.orgA]),
			).toBe(1);
			// Replace in the same organization: the upsert conflicts on (organization_id, user_id).
			await inApp(() => withOrgContext(ids.orgA, () => webAccessService.save(ids.userA, "tavily", "key-a2")));
			const rows = await owner.query(`SELECT provider FROM web_access_credentials WHERE user_id = $1`, [ids.userA]);
			expect(rows.rows).toEqual([{ provider: "tavily" }]);

			const inB = await inApp(() => withOrgContext(ids.orgB, () => webAccessService.status(ids.userA)));
			expect(inB.configured).toBe(false);
			const inA = await inApp(() => withOrgContext(ids.orgA, () => webAccessService.status(ids.userA)));
			expect(inA).toMatchObject({ configured: true, provider: "tavily" });
			// The same user in the other organization has its own, separate row.
			await inApp(() => withOrgContext(ids.orgB, () => webAccessService.save(ids.userA, "exa", "key-b")));
			expect(await count(`SELECT count(*) AS n FROM web_access_credentials WHERE user_id = $1`, [ids.userA])).toBe(2);
		});
	});

	describe("storage cleanup", () => {
		const job = (tag: string) => `uploads/${tag}-${run}`;
		const insertJob = (org: string, owner_: string, tag: string) =>
			owner.query(
				`INSERT INTO storage_cleanup_job (id, organization_id, owner_id, storage_key) VALUES ($1, $2, $3, $4)`,
				[`job-${tag}-${run}`, org, owner_, job(tag)],
			);
		const exists = async (tag: string) =>
			(await count(`SELECT count(*) AS n FROM storage_cleanup_job WHERE id = $1`, [`job-${tag}-${run}`])) === 1;

		it("drains the queue across organizations and one failing job or organization does not stop the rest", async () => {
			const { runStorageCleanup } = await import("./storage/cleanup");
			await insertJob(ids.orgA, ids.userA, "a-ok");
			await insertJob(ids.orgA, ids.userA, "a-fail");
			await insertJob(ids.orgB, ids.userB, "b-ok");
			await insertJob(ids.orgBad, ids.userBad, "bad-ok");
			for (const tag of ["a-ok", "a-fail", "b-ok", "bad-ok"]) store.set(job(tag), tag.endsWith("fail") ? "fail" : "ok");
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
			const summary = await inApp(() => runStorageCleanup({ limit: 500 }));
			expect(error).toHaveBeenCalled();
			error.mockRestore();
			expect(await exists("a-ok")).toBe(false);
			expect(await exists("b-ok")).toBe(false);
			expect(await exists("a-fail"), "a failing delete keeps its durable row").toBe(true);
			expect(await exists("bad-ok"), "an organization withOrgContext refuses is left alone").toBe(true);
			expect(summary.completed).toBeGreaterThanOrEqual(2);
			expect(summary.failed).toBeGreaterThanOrEqual(2);
			const retry = await owner.query(
				`SELECT attempts, claim_token, last_error FROM storage_cleanup_job WHERE id = $1`,
				[`job-a-fail-${run}`],
			);
			expect(retry.rows[0]).toMatchObject({ attempts: 1, claim_token: null, last_error: "storage unavailable" });
		});

		it("lists only ids and organizations, narrowed by owner, keys or organization, to careeros_app only", async () => {
			await owner.query(
				`UPDATE storage_cleanup_job SET next_attempt_at = now() - interval '1 minute' WHERE id LIKE $1`,
				[`%${run}%`],
			);
			const due = await app.query(`SELECT * FROM careeros_due_storage_cleanup(now(), 1000)`);
			expect(Object.keys(due.rows[0] ?? { id: 1, organization_id: 1 }).sort()).toEqual(["id", "organization_id"]);
			expect(due.rows).toEqual(expect.arrayContaining([{ id: `job-a-fail-${run}`, organization_id: ids.orgA }]));
			const byOrg = await app.query(`SELECT * FROM careeros_due_storage_cleanup(now(), 1000, NULL, NULL, $1)`, [
				ids.orgBad,
			]);
			expect(byOrg.rows.every((row) => row.organization_id === ids.orgBad)).toBe(true);
			const byOwner = await app.query(`SELECT * FROM careeros_due_storage_cleanup(now(), 1000, $1)`, [ids.userA]);
			expect(byOwner.rows).toEqual([{ id: `job-a-fail-${run}`, organization_id: ids.orgA }]);
			const byKey = await app.query(
				`SELECT * FROM careeros_due_storage_cleanup(now(), 1000, NULL, ARRAY[$1]::text[])`,
				[job("bad-ok")],
			);
			expect(byKey.rows).toEqual([{ id: `job-bad-ok-${run}`, organization_id: ids.orgBad }]);

			const client = await owner.connect();
			try {
				await client.query(`SET ROLE "${ids.role}"`);
				for (const call of [
					"careeros_due_storage_cleanup(now(), 1)",
					"careeros_stale_custom_domains(now(), 1)",
					"careeros_verified_domains()",
					"careeros_public_domain_owner('x.test')",
					"careeros_public_verified_domain('x')",
					"careeros_guest_cleanup_prefixes('x')",
				])
					await expect(client.query(`SELECT * FROM ${call}`), call).rejects.toMatchObject({ code: "42501" });
			} finally {
				await client.query("RESET ROLE").catch(() => undefined);
				client.release();
			}
		});

		it("keeps erasure work alive after the account, and the organization, are gone", async () => {
			const { runStorageCleanup } = await import("./storage/cleanup");
			const userId = `rem-gone-${run}`;
			const orgId = `rem-gone-org-${run}`;
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [orgId]);
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[userId],
			);
			store.set(`uploads/${userId}`, "ok");
			// The request deletes the account inside its organization; the trigger files the work as the owner role.
			await inApp(() =>
				withOrgContext(orgId, async () => {
					await db.transaction(async (tx) => {
						await tx.delete(schema.user).where(sql`${schema.user.id} = ${userId}`);
					});
				}),
			);
			const filed = await owner.query(`SELECT organization_id, status FROM storage_cleanup_job WHERE owner_id = $1`, [
				userId,
			]);
			expect(filed.rows).toEqual([{ organization_id: orgId, status: "pending" }]);
			// The organization goes too: the job has no foreign key, so it stays.
			await owner.query(`DELETE FROM organization WHERE id = $1`, [orgId]);
			expect(await count(`SELECT count(*) AS n FROM storage_cleanup_job WHERE owner_id = $1`, [userId])).toBe(1);
			const summary = await inApp(() => runStorageCleanup({ ownerId: userId, limit: 5 }));
			expect(summary.completed).toBe(1);
			expect(store.has(`uploads/${userId}`)).toBe(false);
			expect(await count(`SELECT count(*) AS n FROM storage_cleanup_job WHERE owner_id = $1`, [userId])).toBe(0);
		});

		it("files work for a deletion with no organization under the sentinel organization and still processes it", async () => {
			const { runStorageCleanup } = await import("./storage/cleanup");
			const userId = `rem-orphan-${run}`;
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[userId],
			);
			store.set(`uploads/${userId}`, "ok");
			await app.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
			expect(
				(await owner.query(`SELECT organization_id FROM storage_cleanup_job WHERE owner_id = $1`, [userId])).rows,
			).toEqual([{ organization_id: "careeros_orphan" }]);
			const summary = await inApp(() => runStorageCleanup({ ownerId: userId, limit: 5 }));
			expect(summary.completed).toBe(1);
			expect(store.has(`uploads/${userId}`)).toBe(false);
		});

		it("lists a guest's erasure prefixes only for anonymous users", async () => {
			const guest = `rem-guest-${run}`;
			const regular = `rem-regular-${run}`;
			for (const [id, anonymous] of [
				[guest, true],
				[regular, false],
			] as const) {
				await owner.query(
					`INSERT INTO "user" (id, name, email, username, display_username, is_anonymous) VALUES ($1, $1, $1 || '@example.test', $1, $1, $2)`,
					[id, anonymous],
				);
				await owner.query(
					`INSERT INTO storage_cleanup_job (id, organization_id, owner_id, storage_key) VALUES ($1, $2, $3, $4)`,
					[`job-g-${id}`, ids.orgA, id, `uploads/${id}/pictures`],
				);
			}
			const asGuest = await app.query(`SELECT careeros_guest_cleanup_prefixes($1) AS key`, [guest]);
			expect(asGuest.rows).toEqual([{ key: `uploads/${guest}/pictures` }]);
			const asRegular = await app.query(`SELECT careeros_guest_cleanup_prefixes($1) AS key`, [regular]);
			expect(asRegular.rows).toEqual([]);
		});
	});
});
