import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createRouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { auth } from "@reactive-resume/auth/config";
import { db, withDatabasePool } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";
import { authRouter } from "./router";
import { authService } from "./service";

// This suite needs the real organization resolution, not the fixed one from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());

// P1-T03: API keys carry the organization, and account deletion handles organizations. Uses the migrated OAuth test
// database with unique ids and removes what it creates.
describe.skipIf(!process.env.OAUTH_TEST_DATABASE_URL)("organizations and account-level procedures", () => {
	let pool: Pool;
	const run = randomUUID().slice(0, 8);
	const userIds: string[] = [];
	const orgIds: string[] = [];

	beforeAll(() => {
		pool = new Pool({ connectionString: process.env.OAUTH_TEST_DATABASE_URL });
	});

	afterAll(async () => {
		await pool.query("DELETE FROM organization WHERE id = ANY($1::text[])", [orgIds]);
		await pool.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [userIds]);
		await pool.end();
	});

	const createUser = async (label: string) => {
		const id = `${label}-${run}`;
		userIds.push(id);
		const [user] = await db
			.insert(schema.user)
			.values({
				id,
				name: label,
				email: `${id}@example.test`,
				username: id,
				displayUsername: id,
				emailVerified: true,
			})
			.returning();
		if (!user) throw new Error("Missing user fixture");
		return user;
	};

	const createOrganization = async (label: string, members: { userId: string; role: string }[]) => {
		const id = `${label}-${run}`;
		orgIds.push(id);
		await db.insert(schema.organization).values({ id, name: label, slug: id });
		for (const member of members) await db.insert(schema.member).values({ organizationId: id, ...member });
		return id;
	};

	const sessionHeaders = async (userId: string) => {
		const context = await auth.$context;
		const session = await context.internalAdapter.createSession(userId);
		const signature = createHmac("sha256", env.AUTH_SECRET).update(session.token).digest("base64");
		return {
			headers: new Headers({
				cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
			}),
			activeOrganizationId: (session as { activeOrganizationId?: string | null }).activeOrganizationId,
		};
	};

	const clientFor = (
		user: typeof schema.user.$inferSelect,
		headers: Headers,
		activeOrganizationId: string | null | undefined,
	) =>
		createRouterClient(authRouter, {
			context: {
				locale: "en-US",
				reqHeaders: headers,
				resHeaders: new Headers(),
				authentication: { user, method: "session", permissions: ["read", "write", "delete"], activeOrganizationId },
			},
		});

	it("stores the active organization on a new API key, after a membership check", async () => {
		await withDatabasePool(pool, async () => {
			const user = await createUser("key-owner");
			const orgId = await createOrganization("key-org", [{ userId: user.id, role: "owner" }]);
			const { headers, activeOrganizationId } = await sessionHeaders(user.id);
			// The session hook picked the user's only membership.
			expect(activeOrganizationId).toBe(orgId);

			const issued = await clientFor(user, headers, activeOrganizationId).createApiKey({
				name: "With org",
				access: "read",
				expiresIn: null,
			});
			expect(issued.key).toBeTruthy();
			const keys = await db.select().from(schema.apikey).where(eq(schema.apikey.referenceId, user.id));
			expect(keys.map((key) => key.organizationId)).toEqual([orgId]);
		});
	});

	it("stores no organization without an active one, and refuses an organization the user is not in", async () => {
		await withDatabasePool(pool, async () => {
			const user = await createUser("key-none");
			const outsider = await createUser("key-outsider");
			const foreignOrg = await createOrganization("key-foreign", [{ userId: outsider.id, role: "owner" }]);
			const { headers } = await sessionHeaders(user.id);

			await clientFor(user, headers, null).createApiKey({ name: "No org", access: "read", expiresIn: null });
			const keys = await db.select().from(schema.apikey).where(eq(schema.apikey.referenceId, user.id));
			expect(keys.map((key) => key.organizationId)).toEqual([null]);

			await expect(
				clientFor(user, headers, foreignOrg).createApiKey({ name: "Foreign", access: "read", expiresIn: null }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(await db.select().from(schema.apikey).where(eq(schema.apikey.referenceId, user.id))).toHaveLength(1);
		});
	});

	it("deletes the organizations only the account's user belonged to, and keeps shared ones", async () => {
		await withDatabasePool(pool, async () => {
			const leaver = await createUser("leaver");
			const keeper = await createUser("keeper");
			const solo = await createOrganization("solo-org", [{ userId: leaver.id, role: "owner" }]);
			const shared = await createOrganization("kept-org", [
				{ userId: keeper.id, role: "owner" },
				{ userId: leaver.id, role: "member" },
			]);

			await authService.deleteAccount({ userId: leaver.id });

			expect(await db.select().from(schema.user).where(eq(schema.user.id, leaver.id))).toEqual([]);
			expect(await db.select().from(schema.organization).where(eq(schema.organization.id, solo))).toEqual([]);
			expect(await db.select().from(schema.member).where(eq(schema.member.organizationId, solo))).toEqual([]);
			expect(await db.select().from(schema.organization).where(eq(schema.organization.id, shared))).toHaveLength(1);
			const remaining = await db.select().from(schema.member).where(eq(schema.member.organizationId, shared));
			expect(remaining.map((row) => row.userId)).toEqual([keeper.id]);
		});
	});

	it("allows deleting an owner's account when another owner remains", async () => {
		await withDatabasePool(pool, async () => {
			const leaver = await createUser("co-leaver");
			const coOwner = await createUser("co-owner");
			const shared = await createOrganization("co-owned-org", [
				{ userId: leaver.id, role: "owner" },
				{ userId: coOwner.id, role: "owner" },
			]);

			await authService.deleteAccount({ userId: leaver.id });

			expect(await db.select().from(schema.user).where(eq(schema.user.id, leaver.id))).toEqual([]);
			expect(await db.select().from(schema.organization).where(eq(schema.organization.id, shared))).toHaveLength(1);
			const remaining = await db.select().from(schema.member).where(eq(schema.member.organizationId, shared));
			expect(remaining.map((row) => row.userId)).toEqual([coOwner.id]);
		});
	});

	it("refuses to delete an account that owns an organization with other members", async () => {
		await withDatabasePool(pool, async () => {
			const owner = await createUser("blocked-owner");
			const colleague = await createUser("blocked-colleague");
			const shared = await createOrganization("blocked-org", [
				{ userId: owner.id, role: "owner" },
				{ userId: colleague.id, role: "member" },
			]);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

			await expect(authService.deleteAccount({ userId: owner.id })).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
				message: expect.stringContaining("Transfer ownership first"),
			});
			warn.mockRestore();
			expect(await db.select().from(schema.user).where(eq(schema.user.id, owner.id))).toHaveLength(1);
			expect(await db.select().from(schema.organization).where(eq(schema.organization.id, shared))).toHaveLength(1);

			// The colleague, a plain member, can still delete their own account.
			await authService.deleteAccount({ userId: colleague.id });
			expect(await db.select().from(schema.user).where(eq(schema.user.id, colleague.id))).toEqual([]);
		});
	});
});
