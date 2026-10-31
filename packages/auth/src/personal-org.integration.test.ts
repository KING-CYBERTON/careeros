import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { authOrganizationRelations } from "@reactive-resume/db/schema";

const fixture = vi.hoisted(() => ({
	db: undefined as unknown,
	pool: undefined as Pool | undefined,
}));
vi.mock("@reactive-resume/db/client", () => ({
	get db() {
		return fixture.db;
	},
	getPool: () => fixture.pool,
}));
// The invitation email is not under test.
vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

const migrationsFolder = fileURLToPath(new URL("../../../migrations", import.meta.url));
const PASSWORD = "correct-horse-battery";

// Opt-in real PostgreSQL test (P1-T03). Needs CREATE DATABASE permission; owns and deletes one disposable database.
describe.skipIf(!process.env.COVER_LETTER_TEST_DATABASE_URL)(
	"personal organization, invitations and role rules",
	() => {
		let admin: Pool;
		let pool: Pool;
		const databaseName = `personal_org_test_${randomUUID().replaceAll("-", "")}`;
		let auth: typeof import("./config").auth;
		let deleteSoleMemberOrganizations: typeof import("./personal-org").deleteSoleMemberOrganizations;
		let assertNoSharedOrganizationOwnership: typeof import("./personal-org").assertNoSharedOrganizationOwnership;

		const cookieOf = (headers: Headers) =>
			new Headers({
				cookie: headers
					.getSetCookie()
					.map((value) => value.split(";")[0])
					.join("; "),
			});

		const signUp = async (label: string, invitationId?: string, email?: string) => {
			const suffix = randomUUID().slice(0, 8);
			const address = email ?? `${label}-${suffix}@example.test`;
			const { headers, response } = await auth.api.signUpEmail({
				body: {
					name: label,
					email: address,
					password: PASSWORD,
					username: `${label}-${suffix}`,
					...(invitationId ? { invitationId } : {}),
				} as never,
				returnHeaders: true,
			});
			return { email: address, userId: response.user.id, headers: cookieOf(headers) };
		};

		const signIn = async (email: string) => {
			const { headers } = await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
			return cookieOf(headers);
		};

		const activeOrgOf = (session: { session: object } | null) =>
			(session?.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId;

		const orgsOf = async (userId: string) =>
			(
				await pool.query<{ organization_id: string; role: string; name: string; slug: string }>(
					"SELECT m.organization_id, m.role, o.name, o.slug FROM member m JOIN organization o ON o.id = m.organization_id WHERE m.user_id = $1",
					[userId],
				)
			).rows;

		const activeOrgsOf = async (userId: string) =>
			(
				await pool.query<{ active_organization_id: string | null }>(
					"SELECT active_organization_id FROM session WHERE user_id = $1 ORDER BY created_at",
					[userId],
				)
			).rows.map((row) => row.active_organization_id);

		// An owner with a shared organization plus one member per extra role.
		const sharedOrganization = async (roles: ("admin" | "member")[]) => {
			const owner = await signUp("owner");
			const org = await auth.api.createOrganization({
				body: { name: "Shared", slug: `shared-${randomUUID().slice(0, 8)}` },
				headers: owner.headers,
			});
			const members = [];
			for (const role of roles) {
				const user = await signUp(role);
				await pool.query('UPDATE "user" SET email_verified = true WHERE id = $1', [user.userId]);
				const invitation = await auth.api.createInvitation({
					body: { email: user.email, role, organizationId: org.id },
					headers: owner.headers,
				});
				await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: user.headers });
				const memberRow = await pool.query<{ id: string }>(
					"SELECT id FROM member WHERE user_id = $1 AND organization_id = $2",
					[user.userId, org.id],
				);
				members.push({ ...user, memberId: memberRow.rows[0]?.id ?? "" });
			}
			const ownerMember = await pool.query<{ id: string }>(
				"SELECT id FROM member WHERE user_id = $1 AND organization_id = $2",
				[owner.userId, org.id],
			);
			return { owner: { ...owner, memberId: ownerMember.rows[0]?.id ?? "" }, org, members };
		};

		beforeAll(async () => {
			const databaseUrl = process.env.COVER_LETTER_TEST_DATABASE_URL;
			if (!databaseUrl) throw new Error("COVER_LETTER_TEST_DATABASE_URL is required");
			admin = new Pool({ connectionString: databaseUrl });
			await admin.query(`CREATE DATABASE "${databaseName}"`);
			const url = new URL(databaseUrl);
			url.pathname = `/${databaseName}`;
			pool = new Pool({ connectionString: url.toString() });
			fixture.pool = pool;
			fixture.db = drizzle({ client: pool, relations: authOrganizationRelations });
			await migrate(fixture.db as Parameters<typeof migrate>[0], { migrationsFolder });
			({ auth } = await import("./config"));
			({ deleteSoleMemberOrganizations, assertNoSharedOrganizationOwnership } = await import("./personal-org"));
		}, 120_000);

		afterAll(async () => {
			// Let background session work from the last request finish before the database is dropped.
			await new Promise((resolve) => setTimeout(resolve, 250));
			await pool?.end();
			await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
			await admin?.end();
		});

		it("gives a self-signup exactly one personal organization with an owner membership and an active session", async () => {
			const user = await signUp("solo");
			const orgs = await orgsOf(user.userId);
			expect(orgs).toHaveLength(1);
			expect(orgs[0]).toMatchObject({ role: "owner", name: "solo's workspace" });
			expect(orgs[0]?.slug).toBe(`u-${user.userId.slice(-12)}`);
			expect(await activeOrgsOf(user.userId)).toEqual([orgs[0]?.organization_id]);
			const session = await auth.api.getSession({ headers: user.headers });
			expect(activeOrgOf(session)).toBe(orgs[0]?.organization_id);
		});

		it("gives a guest a personal organization and removes it when the guest is deleted", async () => {
			const { response } = await auth.api.signInAnonymous({ returnHeaders: true });
			const guestId = response?.user.id ?? "";
			const orgs = await orgsOf(guestId);
			expect(orgs).toHaveLength(1);
			expect(orgs[0]?.role).toBe("owner");
			expect(await activeOrgsOf(guestId)).toEqual([orgs[0]?.organization_id]);

			const context = await auth.$context;
			await context.internalAdapter.deleteUser(guestId);
			const left = await pool.query("SELECT id FROM organization WHERE id = $1", [orgs[0]?.organization_id]);
			expect(left.rows).toEqual([]);
		});

		it("creates no personal organization for an invited sign-up, and the user joins on acceptance", async () => {
			const owner = await signUp("host");
			const org = await auth.api.createOrganization({
				body: { name: "Host org", slug: `host-${randomUUID().slice(0, 8)}` },
				headers: owner.headers,
			});
			const email = `invitee-${randomUUID().slice(0, 8)}@example.test`;
			const invitation = await auth.api.createInvitation({
				body: { email, role: "member", organizationId: org.id },
				headers: owner.headers,
			});

			const invitee = await signUp("invitee", invitation.id, email);
			expect(await orgsOf(invitee.userId)).toEqual([]);
			expect(await activeOrgsOf(invitee.userId)).toEqual([null]);

			// The sign-up flow verifies the address before the invitee can accept.
			await pool.query('UPDATE "user" SET email_verified = true WHERE id = $1', [invitee.userId]);
			await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: invitee.headers });
			const orgs = await orgsOf(invitee.userId);
			expect(orgs.map((row) => [row.organization_id, row.role])).toEqual([[org.id, "member"]]);
			const session = await auth.api.getSession({ headers: invitee.headers });
			expect(activeOrgOf(session)).toBe(org.id);
			// The next login resolves the only membership.
			const again = await signIn(email);
			const next = await auth.api.getSession({ headers: again });
			expect(activeOrgOf(next)).toBe(org.id);
		});

		it("still creates a personal organization when the invitation id is not for the new email or is not pending", async () => {
			const owner = await signUp("host2");
			const org = await auth.api.createOrganization({
				body: { name: "Host two", slug: `host2-${randomUUID().slice(0, 8)}` },
				headers: owner.headers,
			});
			const invitation = await auth.api.createInvitation({
				body: { email: `someone-${randomUUID().slice(0, 8)}@example.test`, role: "member", organizationId: org.id },
				headers: owner.headers,
			});
			const other = await signUp("other", invitation.id);
			expect(await orgsOf(other.userId)).toHaveLength(1);
			const unknown = await signUp("unknown", "not-an-invitation");
			expect(await orgsOf(unknown.userId)).toHaveLength(1);
		});

		it("keeps the active organization on a second login", async () => {
			const user = await signUp("again");
			const [org] = await orgsOf(user.userId);
			await signIn(user.email);
			const sessions = await activeOrgsOf(user.userId);
			expect(sessions).toHaveLength(2);
			expect(sessions.every((id) => id === org?.organization_id)).toBe(true);
		});

		it("deletes sole-member organizations and refuses while a shared organization is owned", async () => {
			const { owner, org } = await sharedOrganization(["member"]);
			const [personal] = (await orgsOf(owner.userId)).filter((row) => row.organization_id !== org.id);
			await expect(assertNoSharedOrganizationOwnership(owner.userId)).rejects.toThrow(/Transfer ownership first/);

			// Once the shared organization is gone, only the sole-member one is left to delete.
			await pool.query("DELETE FROM organization WHERE id = $1", [org.id]);
			await expect(assertNoSharedOrganizationOwnership(owner.userId)).resolves.toBeUndefined();
			await deleteSoleMemberOrganizations(owner.userId);
			const left = await pool.query("SELECT id FROM organization WHERE id = $1", [personal?.organization_id]);
			expect(left.rows).toEqual([]);
		});

		it("keeps a shared organization when a non-owner member's sole-member cleanup runs", async () => {
			const { org, members } = await sharedOrganization(["member"]);
			const member = members[0];
			if (!member) throw new Error("missing member");
			await assertNoSharedOrganizationOwnership(member.userId);
			await deleteSoleMemberOrganizations(member.userId);
			expect((await pool.query("SELECT id FROM organization WHERE id = $1", [org.id])).rows).toHaveLength(1);
		});

		describe("role rules", () => {
			it("lets a member see no invite rights", async () => {
				const { org, members } = await sharedOrganization(["member"]);
				const member = members[0];
				if (!member) throw new Error("missing member");
				await expect(
					auth.api.createInvitation({
						body: { email: `new-${randomUUID().slice(0, 8)}@example.test`, role: "member", organizationId: org.id },
						headers: member.headers,
					}),
				).rejects.toThrow();
			});

			it("lets an admin invite and remove but not change roles", async () => {
				const { org, members } = await sharedOrganization(["admin", "member"]);
				const [adminMember, plainMember] = members;
				if (!adminMember || !plainMember) throw new Error("missing members");
				await expect(
					auth.api.createInvitation({
						body: { email: `new-${randomUUID().slice(0, 8)}@example.test`, role: "member", organizationId: org.id },
						headers: adminMember.headers,
					}),
				).resolves.toBeTruthy();
				await expect(
					auth.api.updateMemberRole({
						body: { memberId: plainMember.memberId, role: "admin", organizationId: org.id },
						headers: adminMember.headers,
					}),
				).rejects.toMatchObject({ body: { code: "ONLY_OWNERS_CAN_CHANGE_ROLES" } });
				await expect(
					auth.api.removeMember({
						body: { memberIdOrEmail: plainMember.memberId, organizationId: org.id },
						headers: adminMember.headers,
					}),
				).resolves.toBeTruthy();
			});

			it("lets an owner change roles", async () => {
				const { owner, org, members } = await sharedOrganization(["member"]);
				const member = members[0];
				if (!member) throw new Error("missing member");
				await auth.api.updateMemberRole({
					body: { memberId: member.memberId, role: "admin", organizationId: org.id },
					headers: owner.headers,
				});
				const { rows } = await pool.query("SELECT role FROM member WHERE id = $1", [member.memberId]);
				expect(rows).toEqual([{ role: "admin" }]);
			});

			it("never removes or demotes the last owner", async () => {
				const { owner, org, members } = await sharedOrganization(["admin"]);
				const adminMember = members[0];
				if (!adminMember) throw new Error("missing admin");
				await expect(
					auth.api.removeMember({
						body: { memberIdOrEmail: owner.memberId, organizationId: org.id },
						headers: owner.headers,
					}),
				).rejects.toThrow();
				await expect(
					auth.api.removeMember({
						body: { memberIdOrEmail: owner.memberId, organizationId: org.id },
						headers: adminMember.headers,
					}),
				).rejects.toThrow();
				await expect(
					auth.api.updateMemberRole({
						body: { memberId: owner.memberId, role: "member", organizationId: org.id },
						headers: owner.headers,
					}),
				).rejects.toThrow();
				const { rows } = await pool.query("SELECT role FROM member WHERE id = $1", [owner.memberId]);
				expect(rows).toEqual([{ role: "owner" }]);
			});
		});
	},
);
