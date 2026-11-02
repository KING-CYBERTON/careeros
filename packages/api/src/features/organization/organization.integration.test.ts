import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { call } from "@orpc/server";
import { Pool } from "pg";
import { withDatabasePool } from "@reactive-resume/db/client";

// Real organization scope, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());
vi.mock("@reactive-resume/auth/config", () => ({ auth: {}, verifyOAuthToken: vi.fn() }));

// P3-T01: the read-only entitlements and audit procedures, as the `careeros_app` role on a database of its own with
// every migration applied. Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("organization entitlements and audit log (API)", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `ent-a-${run}`,
		orgB: `ent-b-${run}`,
		ownerA: `ent-owner-a-${run}`,
		adminA: `ent-admin-a-${run}`,
		memberA: `ent-member-a-${run}`,
		ownerB: `ent-owner-b-${run}`,
	};
	let owner: Pool;
	let app: Pool;
	let database: IsolatedTestDatabase;
	let router: typeof import("./router").organizationRouter;

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
		withDatabasePool(app, () => call(procedure as never, input as never, { context: context as never })) as Promise<T>;

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("org_t01");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		for (const [org, users] of [
			[
				ids.orgA,
				[
					[ids.ownerA, "owner"],
					[ids.adminA, "admin"],
					[ids.memberA, "member"],
				],
			],
			[ids.orgB, [[ids.ownerB, "owner"]]],
		] as const) {
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
			for (const [user, role] of users) {
				await owner.query(
					`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
					[user],
				);
				await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $1, $3)`, [
					user,
					org,
					role,
				]);
			}
		}
		({ organizationRouter: router } = await import("./router"));
	}, 180_000);

	afterAll(async () => {
		await owner?.end();
		await app?.end();
		await database?.drop();
	});

	describe("organization.entitlements", () => {
		it("lets any member read the current organization's entitlements", async () => {
			for (const user of [ids.ownerA, ids.adminA, ids.memberA]) {
				const result = await invoke<Record<string, unknown>>(router.entitlements, undefined, asUser(user, ids.orgA));
				expect(result).toMatchObject({
					planId: "personal",
					status: "active",
					seatLimit: 1,
					seatsUsed: 3,
					aiCreditsPerSeat: 50,
					// max(1 paid, 3 members) x 50
					aiCreditsTotal: 150,
					overageAllowed: false,
					readOnly: false,
				});
			}
		});

		it("reflects a plan and status change made by the platform", async () => {
			await owner.query(`SELECT careeros_set_org_plan($1, 'pro', 'suspended', NULL, 'test')`, [ids.orgB]);
			const result = await invoke<{ planId: string; readOnly: boolean; features: Record<string, boolean> }>(
				router.entitlements,
				undefined,
				asUser(ids.ownerB, ids.orgB),
			);
			expect(result).toMatchObject({ planId: "pro", readOnly: true, seatLimit: null });
			expect(result.features.custom_domain).toBe(true);
			// Organization A is unaffected.
			expect(
				(await invoke<{ planId: string }>(router.entitlements, undefined, asUser(ids.ownerA, ids.orgA))).planId,
			).toBe("personal");
		});

		it("answers for the caller's own organization only", async () => {
			// A member of Organization B cannot read Organization A's entitlements by naming it: the scope comes from membership.
			await expect(invoke(router.entitlements, undefined, asUser(ids.ownerB, ids.orgA))).rejects.toBeTruthy();
		});

		it("refuses an anonymous caller", async () => {
			await expect(
				invoke(router.entitlements, undefined, { authentication: null, reqHeaders: new Headers(), locale: "en-US" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		});
	});

	describe("organization.audit", () => {
		beforeAll(async () => {
			// Thirteen entries in A, spaced in time so the order is unambiguous, and one in B.
			for (let n = 1; n <= 13; n++)
				await owner.query(
					`INSERT INTO audit_log (organization_id, actor_user_id, action, target_type, target_id, created_at)
					 VALUES ($1, $2, $3, 'thing', $4, now() - ($5 || ' minutes')::interval)`,
					[ids.orgA, ids.ownerA, `test.entry_${String(n).padStart(2, "0")}`, `t-${n}`, String(100 - n)],
				);
			await owner.query(`INSERT INTO audit_log (organization_id, action) VALUES ($1, 'test.other_org')`, [ids.orgB]);
			await owner.query(`SELECT careeros_audit_platform($1, NULL, 'test.platform_entry', NULL, NULL, '{}', NULL)`, [
				ids.ownerA,
			]);
		});

		type Page = { items: { action: string; createdAt: Date }[]; nextCursor: string | null };

		it("lists the organization's entries newest first, a page at a time", async () => {
			const first = await invoke<Page>(router.audit, { limit: 5 }, asUser(ids.ownerA, ids.orgA));
			expect(first.items.map((item) => item.action)).toEqual([
				"test.entry_13",
				"test.entry_12",
				"test.entry_11",
				"test.entry_10",
				"test.entry_09",
			]);
			expect(first.nextCursor).toBeTruthy();
			const second = await invoke<Page>(
				router.audit,
				{ limit: 5, cursor: first.nextCursor ?? "" },
				asUser(ids.ownerA, ids.orgA),
			);
			expect(second.items.map((item) => item.action)).toEqual([
				"test.entry_08",
				"test.entry_07",
				"test.entry_06",
				"test.entry_05",
				"test.entry_04",
			]);
			const third = await invoke<Page>(
				router.audit,
				{ limit: 5, cursor: second.nextCursor ?? "" },
				asUser(ids.adminA, ids.orgA),
			);
			expect(third.items.map((item) => item.action)).toEqual(["test.entry_03", "test.entry_02", "test.entry_01"]);
			expect(third.nextCursor).toBeNull();
		});

		it("never shows another organization's entries or platform entries", async () => {
			const all = await invoke<Page>(router.audit, { limit: 100 }, asUser(ids.ownerA, ids.orgA));
			const actions = all.items.map((item) => item.action);
			expect(actions).not.toContain("test.other_org");
			expect(actions).not.toContain("test.platform_entry");
			const other = await invoke<Page>(router.audit, {}, asUser(ids.ownerB, ids.orgB));
			expect(other.items.map((item) => item.action)).toContain("test.other_org");
			expect(other.items.map((item) => item.action)).not.toContain("test.entry_01");
		});

		it("does not return the ip of an entry", async () => {
			await owner.query(
				`INSERT INTO audit_log (organization_id, action, ip) VALUES ($1, 'test.with_ip', '203.0.113.9')`,
				[ids.orgA],
			);
			const page = await invoke<{ items: Record<string, unknown>[] }>(
				router.audit,
				{ limit: 100 },
				asUser(ids.ownerA, ids.orgA),
			);
			const entry = page.items.find((item) => item.action === "test.with_ip");
			expect(entry).toBeDefined();
			expect(entry).not.toHaveProperty("ip");
			expect(JSON.stringify(page)).not.toContain("203.0.113.9");
		});

		it("is for owners and admins only", async () => {
			await expect(invoke(router.audit, {}, asUser(ids.memberA, ids.orgA))).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(invoke(router.audit, {}, asUser(ids.adminA, ids.orgA))).resolves.toBeTruthy();
		});

		it("rejects a malformed cursor and an out-of-range limit", async () => {
			await expect(
				invoke(router.audit, { cursor: "not-a-cursor" }, asUser(ids.ownerA, ids.orgA)),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			await expect(invoke(router.audit, { limit: 0 }, asUser(ids.ownerA, ids.orgA))).rejects.toBeTruthy();
			await expect(invoke(router.audit, { limit: 101 }, asUser(ids.ownerA, ids.orgA))).rejects.toBeTruthy();
		});
	});
});
