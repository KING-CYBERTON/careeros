import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";
import { withDatabasePool } from "@reactive-resume/db/client";

// P2-T03: the host rules of resolveOrgForAuthentication and the slug lookup, on a database of its own with every
// migration applied, read as the `careeros_app` role. Skipped only when the CAREEROS_TEST_* variables are absent.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("organization host rules (real Postgres)", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `host-a-${run}`,
		orgB: `host-b-${run}`,
		inA: `host-user-a-${run}`,
		inB: `host-user-b-${run}`,
		inBoth: `host-user-both-${run}`,
		outsider: `host-outsider-${run}`,
		keyA: `host-key-a-${run}`,
		keyB: `host-key-b-${run}`,
		keyNone: `host-key-none-${run}`,
		keyOutsiderA: `host-key-out-${run}`,
	};
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let tenancy: typeof import("./index");

	const host = (organizationId: string) =>
		({
			kind: "org",
			organizationId,
			slug: organizationId,
			via: "subdomain",
			hostname: `${organizationId}.test`,
			origin: `https://${organizationId}.test`,
		}) as const;
	const inApp = <T>(fn: () => T) => withDatabasePool(app, fn);
	const resolve = (
		authentication: Parameters<typeof import("./index").resolveOrgForAuthentication>[0],
		hostContext?: Parameters<typeof import("./index").resolveOrgForAuthentication>[1],
	) => inApp(() => tenancy.resolveOrgForAuthentication(authentication, hostContext));
	const session = (userId: string, activeOrganizationId: string | null) =>
		({ method: "session", user: { id: userId }, activeOrganizationId }) as const;
	const key = (userId: string, apiKeyId: string) => ({ method: "apiKey", user: { id: userId }, apiKeyId }) as const;
	const bearer = (userId: string) => ({ method: "bearer", user: { id: userId } }) as const;

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("host_t03");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		for (const org of [ids.orgA, ids.orgB])
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
		const members: [string, string, string][] = [
			[ids.inA, ids.orgA, "2026-01-01T00:00:00Z"],
			[ids.inB, ids.orgB, "2026-01-01T00:00:00Z"],
			// The oldest membership of inBoth is Org A.
			[ids.inBoth, ids.orgA, "2026-01-01T00:00:00Z"],
			[ids.inBoth, ids.orgB, "2026-02-01T00:00:00Z"],
		];
		for (const user of [ids.inA, ids.inB, ids.inBoth, ids.outsider])
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[user],
			);
		for (const [user, org, createdAt] of members)
			await owner.query(
				`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'member', $4)`,
				[`m-${user}-${org}`, org, user, createdAt],
			);
		const keys: [string, string, string | null][] = [
			[ids.keyA, ids.inBoth, ids.orgA],
			[ids.keyB, ids.inBoth, ids.orgB],
			[ids.keyNone, ids.inBoth, null],
			// A key of a user who is no member of the organization it names.
			[ids.keyOutsiderA, ids.outsider, ids.orgA],
		];
		for (const [id, user, org] of keys)
			await owner.query(`INSERT INTO apikey (id, key, reference_id, organization_id) VALUES ($1, $1, $2, $3)`, [
				id,
				user,
				org,
			]);
		tenancy = await import("./index");
	}, 120_000);

	afterAll(async () => {
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	describe("slug lookup", () => {
		it("finds an organization by slug through the public function, as careeros_app without an organization", async () => {
			await expect(inApp(() => tenancy.lookupOrgBySlug(ids.orgA))).resolves.toEqual({
				organizationId: ids.orgA,
				slug: ids.orgA,
			});
		});

		it("returns null for an unknown slug", async () => {
			await expect(inApp(() => tenancy.lookupOrgBySlug(`nobody-${run}`))).resolves.toBeNull();
		});
	});

	describe("session", () => {
		it("a member of Org A on Org A's host acts in Org A", async () => {
			await expect(resolve(session(ids.inA, ids.orgA), host(ids.orgA))).resolves.toBe(ids.orgA);
		});

		it("ignores the session's active organization on an organization host", async () => {
			// inBoth is a member of both; the active organization is B, the host is A.
			await expect(resolve(session(ids.inBoth, ids.orgB), host(ids.orgA))).resolves.toBe(ids.orgA);
			await expect(resolve(session(ids.inBoth, null), host(ids.orgA))).resolves.toBe(ids.orgA);
		});

		it("refuses the same user on another organization's host (not a member)", async () => {
			await expect(resolve(session(ids.inA, ids.orgA), host(ids.orgB))).rejects.toMatchObject({
				name: "TenancyError",
				code: "not_member_of_host_org",
			});
			await expect(resolve(session(ids.outsider, null), host(ids.orgA))).rejects.toMatchObject({
				code: "not_member_of_host_org",
			});
		});

		it("on the platform host keeps the Phase 1 rule: the active organization after a membership check", async () => {
			await expect(resolve(session(ids.inA, ids.orgA), { kind: "platform" })).resolves.toBe(ids.orgA);
			await expect(resolve(session(ids.inA, ids.orgB), { kind: "platform" })).resolves.toBeUndefined();
			await expect(resolve(session(ids.inA, ids.orgA))).resolves.toBe(ids.orgA);
			await expect(resolve(session(ids.inA, null), { kind: "platform" })).resolves.toBeUndefined();
		});
	});

	describe("API key", () => {
		it("a key bound to Org A acts in Org A on Org A's host", async () => {
			await expect(resolve(key(ids.inBoth, ids.keyA), host(ids.orgA))).resolves.toBe(ids.orgA);
		});

		it("a key bound to Org A is refused on Org B's host, although its owner is a member of both", async () => {
			await expect(resolve(key(ids.inBoth, ids.keyA), host(ids.orgB))).rejects.toMatchObject({
				code: "key_org_mismatch",
			});
			await expect(resolve(key(ids.inBoth, ids.keyB), host(ids.orgA))).rejects.toMatchObject({
				code: "key_org_mismatch",
			});
		});

		it("a key on the platform host behaves as before", async () => {
			await expect(resolve(key(ids.inBoth, ids.keyA), { kind: "platform" })).resolves.toBe(ids.orgA);
			await expect(resolve(key(ids.inBoth, ids.keyB), { kind: "platform" })).resolves.toBe(ids.orgB);
			await expect(resolve(key(ids.inBoth, ids.keyA))).resolves.toBe(ids.orgA);
			// A key without an organization falls back to the oldest membership, on the platform host only.
			await expect(resolve(key(ids.inBoth, ids.keyNone), { kind: "platform" })).resolves.toBe(ids.orgA);
		});

		it("a key without an organization acts in the host organization when its owner is a member", async () => {
			await expect(resolve(key(ids.inBoth, ids.keyNone), host(ids.orgB))).resolves.toBe(ids.orgB);
			await expect(resolve(key(ids.inBoth, ids.keyNone), host(ids.orgA))).resolves.toBe(ids.orgA);
		});

		it("refuses a key without an organization whose owner is no member of the host organization", async () => {
			await expect(resolve(key(ids.inA, ids.keyNone), host(ids.orgB))).rejects.toMatchObject({
				code: "not_member_of_host_org",
			});
		});

		it("refuses a key whose owner left the organization it names", async () => {
			await expect(resolve(key(ids.outsider, ids.keyOutsiderA), host(ids.orgA))).rejects.toMatchObject({
				code: "not_member_of_host_org",
			});
		});
	});

	describe("OAuth bearer token", () => {
		it("acts in the host organization for a member, on either of two hosts", async () => {
			await expect(resolve(bearer(ids.inBoth), host(ids.orgB))).resolves.toBe(ids.orgB);
			await expect(resolve(bearer(ids.inBoth), host(ids.orgA))).resolves.toBe(ids.orgA);
		});

		it("is refused for a non-member of the host organization", async () => {
			await expect(resolve(bearer(ids.inA), host(ids.orgB))).rejects.toMatchObject({
				code: "not_member_of_host_org",
			});
		});

		it("on the platform host falls back to the oldest membership", async () => {
			await expect(resolve(bearer(ids.inBoth), { kind: "platform" })).resolves.toBe(ids.orgA);
		});
	});

	describe("unknown hosts", () => {
		it("fails closed on a host shaped like an organization host that names none", async () => {
			await expect(
				resolve(session(ids.inA, ids.orgA), { kind: "unknown", matchesOrgPattern: true }),
			).rejects.toMatchObject({ code: "unknown_org_host" });
		});

		it("leaves other unknown hosts on the Phase 1 rules", async () => {
			await expect(resolve(session(ids.inA, ids.orgA), { kind: "unknown", matchesOrgPattern: false })).resolves.toBe(
				ids.orgA,
			);
		});
	});
});
