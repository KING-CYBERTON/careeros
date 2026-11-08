import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { call, isProcedure } from "@orpc/server";
import { Pool } from "pg";

// Real organization scope and real entitlements, not the fixed ones from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());
vi.mock("@careeros/billing", async (importOriginal) => importOriginal());
// No real mail: the invitation email goes through this stub.
vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

// P3-T08: the Org Admin console, as the `careeros_app` role on a database of its own with every migration applied, with
// the real Better Auth configuration behind the bulk invitations (hooks, seat trigger, invitation email stub). Skipped
// only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const PASSWORD = "correct-horse-battery";
const PLATFORM = "localhost:3000";

type Person = { userId: string; email: string; cookie: string };

describe.skipIf(!configured)("Org Admin console (API)", () => {
	const run = randomUUID().slice(0, 8);
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let auth: typeof import("@reactive-resume/auth/config").auth;
	let admin: typeof import("./router").orgAdminRouter;
	let organization: typeof import("../organization/router").organizationRouter;
	let runWithEntitlementsCache: typeof import("@careeros/billing").runWithEntitlementsCache;

	// ---- helpers ----------------------------------------------------------------------------------------------
	const authRequest = (path: string, body: unknown, cookie?: string) =>
		auth.handler(
			new Request(`http://${PLATFORM}/api/auth${path}`, {
				method: "POST",
				headers: {
					host: PLATFORM,
					"content-type": "application/json",
					origin: `http://${PLATFORM}`,
					...(cookie ? { cookie } : {}),
				},
				body: JSON.stringify(body),
			}),
		);

	const signUp = async (label: string): Promise<Person> => {
		const suffix = randomUUID().slice(0, 8);
		const email = `${label}-${suffix}@example.test`;
		const response = await authRequest("/sign-up/email", {
			name: label,
			email,
			password: PASSWORD,
			username: `${label}-${suffix}`,
		});
		expect(response.status).toBe(200);
		const { user } = (await response.json()) as { user: { id: string } };
		await owner.query(`UPDATE "user" SET email_verified = true WHERE id = $1`, [user.id]);
		const cookie = response.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		return { userId: user.id, email, cookie };
	};

	const setPlan = (organizationId: string, plan: string, status: string | null = null) =>
		owner.query(`SELECT careeros_set_org_plan($1, $2, $3, NULL, 'test fixture')`, [organizationId, plan, status]);

	/** A real organization made through Better Auth, with `founder` as its owner. */
	const createOrganization = async (founder: Person, plan: string) => {
		const slug = `adm-${randomUUID().slice(0, 8)}`;
		const response = await authRequest("/organization/create", { name: slug, slug }, founder.cookie);
		expect(response.status).toBe(200);
		const { id } = (await response.json()) as { id: string };
		await setPlan(id, plan);
		return id;
	};

	/** A user and member row made directly (no sign-in), for rows the console reads. */
	const addMember = async (organizationId: string, label: string, role = "member", name = label) => {
		const id = `${label}-${run}-${randomUUID().slice(0, 6)}`;
		await owner.query(
			`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $2, $1 || '@example.test', $1, $1)`,
			[id, name],
		);
		await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $1, $3)`, [
			id,
			organizationId,
			role,
		]);
		return { userId: id, memberId: id, email: `${id}@example.test` };
	};

	const context = (person: { userId: string; cookie?: string }, organizationId: string) => ({
		authentication: {
			user: { id: person.userId },
			method: "session" as const,
			permissions: ["read", "write", "delete"] as const,
			activeOrganizationId: organizationId,
		},
		reqHeaders: new Headers({
			host: PLATFORM,
			origin: `http://${PLATFORM}`,
			...(person.cookie ? { cookie: person.cookie } : {}),
		}),
		locale: "en-US",
	});
	const invoke = <T>(procedure: unknown, input: unknown, ctx: unknown): Promise<T> =>
		call(procedure as never, input as never, { context: ctx as never }) as Promise<T>;

	const csvFile = (text: string) => new File([text], "invites.csv", { type: "text/csv" });
	const count = async (sql: string, params: unknown[] = []) =>
		Number((await owner.query<{ n: string }>(sql, params)).rows[0]?.n);
	const seatsUsed = (organizationId: string) =>
		count(
			`SELECT (SELECT count(*) FROM member WHERE organization_id = $1)
			      + (SELECT count(*) FROM invitation WHERE organization_id = $1 AND status = 'pending' AND expires_at > now()) AS n`,
			[organizationId],
		);

	type InviteReport = {
		rows: { email: string; status: string }[];
		counts: Record<string, number>;
		sent: number;
		seatLimit: number | null;
		seatsUsed: number;
	};

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("orgadm_t08");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		// The configuration reads the environment when it is imported.
		process.env.DATABASE_URL = database.appUrl;
		process.env.APP_URL = `http://${PLATFORM}`;
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		// A small Starter limit, as the spec's end-to-end case needs: the founder plus two more.
		await owner.query(`UPDATE plan SET seat_limit = 3 WHERE id = 'starter'`);
		({ auth } = await import("@reactive-resume/auth/config"));
		({ runWithEntitlementsCache } = await import("@careeros/billing"));
		({ orgAdminRouter: admin } = await import("./router"));
		({ organizationRouter: organization } = await import("../organization/router"));
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	// ---- row-level security ---------------------------------------------------------------------------------------
	describe("cohort table", () => {
		it("is row-level secured: the app role sees and writes only the current organization's cohorts", async () => {
			const founderA = await signUp("rlsa");
			const founderB = await signUp("rlsb");
			const orgA = await createOrganization(founderA, "pro");
			const orgB = await createOrganization(founderB, "pro");
			await owner.query(
				`INSERT INTO cohort (id, organization_id, name) VALUES ($1, $2, 'A only'), ($3, $4, 'B only')`,
				[`rls-a-${run}`, orgA, `rls-b-${run}`, orgB],
			);
			const client = await app.connect();
			try {
				// No organization setting: nothing (fail closed).
				expect((await client.query(`SELECT id FROM cohort`)).rowCount).toBe(0);
				await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgA]);
				expect((await client.query<{ id: string }>(`SELECT id FROM cohort`)).rows.map((row) => row.id)).toEqual([
					`rls-a-${run}`,
				]);
				await expect(
					client.query(`INSERT INTO cohort (id, organization_id, name) VALUES ('forged', $1, 'forged')`, [orgB]),
				).rejects.toThrow(/row-level security/);
				expect((await client.query(`UPDATE cohort SET name = 'x' WHERE id = $1`, [`rls-b-${run}`])).rowCount).toBe(0);
				expect((await client.query(`DELETE FROM cohort WHERE id = $1`, [`rls-b-${run}`])).rowCount).toBe(0);
			} finally {
				await client.query(`SELECT set_config('app.current_org_id', '', false)`);
				client.release();
			}
		});

		it("clears the cohort of its members and invitations when it is deleted, never their organization", async () => {
			const founder = await signUp("del");
			const org = await createOrganization(founder, "pro");
			await owner.query(`INSERT INTO cohort (id, organization_id, name) VALUES ($1, $2, 'Going')`, [`del-${run}`, org]);
			const member = await addMember(org, "delm");
			await owner.query(`UPDATE member SET cohort_id = $1 WHERE id = $2`, [`del-${run}`, member.memberId]);
			await owner.query(`DELETE FROM cohort WHERE id = $1`, [`del-${run}`]);
			const row = (await owner.query(`SELECT organization_id, cohort_id FROM member WHERE id = $1`, [member.memberId]))
				.rows[0];
			expect(row).toEqual({ organization_id: org, cohort_id: null });
		});

		it("refuses a member or invitation that names another organization's cohort", async () => {
			const founderA = await signUp("xka");
			const founderB = await signUp("xkb");
			const orgA = await createOrganization(founderA, "pro");
			const orgB = await createOrganization(founderB, "pro");
			await owner.query(`INSERT INTO cohort (id, organization_id, name) VALUES ($1, $2, 'B cohort')`, [
				`xk-${run}`,
				orgB,
			]);
			const member = await addMember(orgA, "xkm");
			await expect(
				owner.query(`UPDATE member SET cohort_id = $1 WHERE id = $2`, [`xk-${run}`, member.memberId]),
			).rejects.toThrow(/member_org_cohort_fkey/);
		});
	});

	// ---- who may use it ---------------------------------------------------------------------------------------------
	describe("access", () => {
		const walk = (node: unknown, path: string[], out: [string, unknown][]) => {
			if (isProcedure(node)) out.push([path.join("."), node]);
			else if (node && typeof node === "object")
				for (const [key, child] of Object.entries(node)) walk(child, [...path, key], out);
			return out;
		};
		const minimalInput = (name: string): unknown => {
			if (name.startsWith("cohorts.create")) return { name: "Nope" };
			if (name.startsWith("cohorts.update")) return { id: "x", name: "Nope" };
			if (name.startsWith("cohorts.archive")) return { id: "x" };
			if (name === "members.setCohort") return { memberIds: ["x"], cohortId: null };
			if (name.startsWith("invitations.")) return { file: csvFile("email\na@example.test\n") };
			return undefined;
		};

		it("refuses a plain member on every procedure", async () => {
			const founder = await signUp("acc");
			const org = await createOrganization(founder, "pro");
			const plain = await addMember(org, "plain");
			const procedures = walk(admin, [], []);
			expect(procedures.length).toBeGreaterThanOrEqual(12);
			for (const [name, procedure] of procedures)
				await expect(invoke(procedure, minimalInput(name), context(plain, org)), name).rejects.toMatchObject({
					code: "FORBIDDEN",
					data: { code: "ORG_ADMIN_REQUIRED" },
				});
		});

		it("refuses a personal workspace, even to its owner", async () => {
			const founder = await signUp("pers");
			const [{ id: personalOrg }] = (
				await owner.query<{ id: string }>(`SELECT organization_id AS id FROM member WHERE user_id = $1`, [
					founder.userId,
				])
			).rows as [{ id: string }];
			expect((await owner.query(`SELECT plan_id FROM organization WHERE id = $1`, [personalOrg])).rows[0]).toEqual({
				plan_id: "personal",
			});
			for (const [name, procedure] of walk(admin, [], []))
				await expect(invoke(procedure, minimalInput(name), context(founder, personalOrg)), name).rejects.toMatchObject({
					code: "FORBIDDEN",
					data: { code: "PERSONAL_WORKSPACE" },
				});
		});

		it("lets owners and admins in", async () => {
			const founder = await signUp("ok");
			const org = await createOrganization(founder, "pro");
			const second = await addMember(org, "adm", "admin");
			for (const person of [founder, second])
				expect(await invoke(admin.cohorts.list, undefined, context(person, org))).toEqual([]);
		});
	});

	// ---- cohorts and members --------------------------------------------------------------------------------------
	describe("cohorts and members", () => {
		it("creates, updates, archives and lists cohorts, and audits each change", async () => {
			const founder = await signUp("coh");
			const org = await createOrganization(founder, "pro");
			const ctx = context(founder, org);
			const created = await invoke<{ id: string; name: string; memberCount: number }>(
				admin.cohorts.create,
				{ name: "Spring 26", description: "Intake", startsOn: "2026-03-01", endsOn: "2026-06-30" },
				ctx,
			);
			expect(created).toMatchObject({ name: "Spring 26", memberCount: 0 });
			await expect(invoke(admin.cohorts.create, { name: "spring 26" }, ctx)).rejects.toMatchObject({
				code: "CONFLICT",
			});
			await expect(
				invoke(admin.cohorts.update, { id: created.id, startsOn: "2026-07-01", endsOn: "2026-06-01" }, ctx),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			const updated = await invoke<{ name: string }>(
				admin.cohorts.update,
				{ id: created.id, name: "Spring 2026" },
				ctx,
			);
			expect(updated.name).toBe("Spring 2026");
			await invoke(admin.cohorts.archive, { id: created.id }, ctx);
			expect(await invoke<unknown[]>(admin.cohorts.list, undefined, ctx)).toEqual([]);
			expect(await invoke<unknown[]>(admin.cohorts.list, { includeArchived: true }, ctx)).toHaveLength(1);
			await invoke(admin.cohorts.archive, { id: created.id, archived: false }, ctx);
			expect(await invoke<unknown[]>(admin.cohorts.list, undefined, ctx)).toHaveLength(1);
			// Names longer than 100 characters never reach the database.
			await expect(invoke(admin.cohorts.create, { name: "x".repeat(101) }, ctx)).rejects.toBeTruthy();
			const actions = (
				await owner.query<{ action: string }>(
					`SELECT action FROM audit_log WHERE organization_id = $1 ORDER BY created_at`,
					[org],
				)
			).rows.map((row) => row.action);
			expect(actions).toEqual(
				expect.arrayContaining(["cohort.created", "cohort.updated", "cohort.archived", "cohort.restored"]),
			);
		});

		it("moves members in and out of a cohort, 500 at most, and not into an archived one", async () => {
			const founder = await signUp("mv");
			const org = await createOrganization(founder, "pro");
			const ctx = context(founder, org);
			const cohort = await invoke<{ id: string }>(admin.cohorts.create, { name: "Move" }, ctx);
			const people = await Promise.all([addMember(org, "mv1"), addMember(org, "mv2")]);
			const moved = await invoke<{ updated: number }>(
				admin.members.setCohort,
				{ memberIds: people.map((p) => p.memberId), cohortId: cohort.id },
				ctx,
			);
			expect(moved.updated).toBe(2);
			const listed = await invoke<{ items: { cohortName: string | null }[]; total: number }>(
				admin.members.list,
				{ cohortId: cohort.id },
				ctx,
			);
			expect(listed.total).toBe(2);
			expect(listed.items.every((item) => item.cohortName === "Move")).toBe(true);
			await invoke(admin.members.setCohort, { memberIds: [people[0]?.memberId], cohortId: null }, ctx);
			expect((await invoke<{ total: number }>(admin.members.list, { cohortId: cohort.id }, ctx)).total).toBe(1);
			await expect(
				invoke(
					admin.members.setCohort,
					{ memberIds: Array.from({ length: 501 }, (_, i) => `m${i}`), cohortId: null },
					ctx,
				),
			).rejects.toBeTruthy();
			await invoke(admin.cohorts.archive, { id: cohort.id }, ctx);
			await expect(
				invoke(admin.members.setCohort, { memberIds: [people[1]?.memberId], cohortId: cohort.id }, ctx),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});

		it("shows a member their own cohort name", async () => {
			const founder = await signUp("mine");
			const org = await createOrganization(founder, "pro");
			const ctx = context(founder, org);
			const cohort = await invoke<{ id: string }>(admin.cohorts.create, { name: "Mine" }, ctx);
			const member = await addMember(org, "minem");
			expect(await invoke(organization.myCohort, undefined, context(member, org))).toEqual({ cohortName: null });
			await invoke(admin.members.setCohort, { memberIds: [member.memberId], cohortId: cohort.id }, ctx);
			expect(await invoke(organization.myCohort, undefined, context(member, org))).toEqual({ cohortName: "Mine" });
		});
	});

	// ---- another organization --------------------------------------------------------------------------------------
	describe("another organization", () => {
		it("never lets the admin of organization B see or change organization A's cohorts, members, analytics or audit rows", async () => {
			const founderA = await signUp("tena");
			const founderB = await signUp("tenb");
			const orgA = await createOrganization(founderA, "pro");
			const orgB = await createOrganization(founderB, "pro");
			const ctxA = context(founderA, orgA);
			const ctxB = context(founderB, orgB);
			const cohortA = await invoke<{ id: string }>(admin.cohorts.create, { name: "Secret A cohort" }, ctxA);
			const memberA = await addMember(orgA, "tenam", "member", "Secret A Person");
			await invoke(admin.members.setCohort, { memberIds: [memberA.memberId], cohortId: cohortA.id }, ctxA);

			// B lists its own and sees none of A's.
			expect(JSON.stringify(await invoke(admin.cohorts.list, { includeArchived: true }, ctxB))).not.toContain(
				"Secret A",
			);
			const listedB = await invoke(admin.members.list, {}, ctxB);
			expect(JSON.stringify(listedB)).not.toContain("Secret A");
			expect(JSON.stringify(listedB)).not.toContain(memberA.email);
			const tableB = await invoke(admin.analytics.members, {}, ctxB);
			expect(JSON.stringify(tableB)).not.toContain("Secret A");

			// B cannot name A's cohort anywhere.
			await expect(invoke(admin.cohorts.update, { id: cohortA.id, name: "Hijack" }, ctxB)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(invoke(admin.cohorts.archive, { id: cohortA.id }, ctxB)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(invoke(admin.analytics.summary, { cohortId: cohortA.id }, ctxB)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(invoke(admin.analytics.members, { cohortId: cohortA.id }, ctxB)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(invoke(admin.analytics.exportMembers, { cohortId: cohortA.id }, ctxB)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(
				invoke(admin.members.setCohort, { memberIds: [memberA.memberId], cohortId: cohortA.id }, ctxB),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			// B's own cohort, A's member id: nothing is updated.
			const cohortB = await invoke<{ id: string }>(admin.cohorts.create, { name: "B cohort" }, ctxB);
			expect(
				await invoke(admin.members.setCohort, { memberIds: [memberA.memberId], cohortId: cohortB.id }, ctxB),
			).toEqual({ updated: 0 });
			expect(
				await count(`SELECT count(*) AS n FROM member WHERE id = $1 AND cohort_id = $2`, [
					memberA.memberId,
					cohortA.id,
				]),
			).toBe(1);
			expect((await owner.query(`SELECT name FROM cohort WHERE id = $1`, [cohortA.id])).rows[0]).toEqual({
				name: "Secret A cohort",
			});

			// B's audit view holds none of A's entries.
			const auditB = await invoke<{ items: { action: string; targetId: string | null }[] }>(
				organization.audit,
				{ limit: 100 },
				ctxB,
			);
			expect(auditB.items.some((item) => item.targetId === cohortA.id)).toBe(false);
			// A caller cannot act in an organization they are not in, whatever the session says.
			await expect(invoke(admin.cohorts.list, undefined, context(founderB, orgA))).rejects.toBeTruthy();
		});
	});

	// ---- bulk invitations -----------------------------------------------------------------------------------------
	describe("bulk invitations", () => {
		it("dry-runs three rows with one over the seat limit, sends nothing, then confirms and sends two", async () => {
			const founder = await signUp("bulk");
			const org = await createOrganization(founder, "starter");
			const ctx = context(founder, org);
			const cohort = await invoke<{ id: string }>(admin.cohorts.create, { name: "Spring" }, ctx);
			const csv = `email,role,cohort\r\nfirst-${run}@example.test,member,Spring\r\nsecond-${run}@example.test,admin,\r\nthird-${run}@example.test,member,\r\n`;

			const dry = await invoke<InviteReport>(admin.invitations.dryRun, { file: csvFile(csv) }, ctx);
			expect(dry.rows.map((row) => row.status)).toEqual(["ok", "ok", "over_seat_limit"]);
			expect(dry.sent).toBe(0);
			expect(dry.seatLimit).toBe(3);
			expect(await seatsUsed(org)).toBe(1);

			// Inside a request-scoped entitlements cache, as in production: the report still shows the seats after sending.
			const sent = await runWithEntitlementsCache(() =>
				invoke<InviteReport>(admin.invitations.confirm, { file: csvFile(csv) }, ctx),
			);
			expect(sent.seatsUsed).toBe(3);
			expect(sent.rows.map((row) => row.status)).toEqual(["ok", "ok", "over_seat_limit"]);
			expect(sent.sent).toBe(2);
			expect(await seatsUsed(org)).toBe(3);
			const invitations = (
				await owner.query<{ email: string; role: string; cohort_id: string | null }>(
					`SELECT email, role, cohort_id FROM invitation WHERE organization_id = $1 ORDER BY email`,
					[org],
				)
			).rows;
			expect(invitations).toEqual([
				{ email: `first-${run}@example.test`, role: "member", cohort_id: cohort.id },
				{ email: `second-${run}@example.test`, role: "admin", cohort_id: null },
			]);

			// The same file again: the two are already invited, the third still has no seat.
			const again = await invoke<InviteReport>(admin.invitations.dryRun, { file: csvFile(csv) }, ctx);
			expect(again.rows.map((row) => row.status)).toEqual(["already_invited", "already_invited", "over_seat_limit"]);

			// One audit row for the upload: counts, never the addresses.
			const audits = (
				await owner.query<{ metadata: Record<string, unknown> }>(
					`SELECT metadata FROM audit_log WHERE organization_id = $1 AND action = 'invitations.bulk_sent'`,
					[org],
				)
			).rows;
			expect(audits).toHaveLength(1);
			expect(audits[0]?.metadata).toMatchObject({ rows: 3, sent: 2, counts: { ok: 2, over_seat_limit: 1 } });
			expect(JSON.stringify(audits[0]?.metadata)).not.toContain("@");
		});

		it("puts an invited person into the named cohort when they accept", async () => {
			const founder = await signUp("acpt");
			const org = await createOrganization(founder, "starter");
			const ctx = context(founder, org);
			const cohort = await invoke<{ id: string }>(admin.cohorts.create, { name: "Joiners" }, ctx);
			const guest = await signUp("guest");
			await invoke(admin.invitations.confirm, { file: csvFile(`email,cohort\r\n${guest.email},Joiners\r\n`) }, ctx);
			const invitationId = (
				await owner.query<{ id: string }>(`SELECT id FROM invitation WHERE organization_id = $1 AND email = $2`, [
					org,
					guest.email,
				])
			).rows[0]?.id;
			const accepted = await authRequest("/organization/accept-invitation", { invitationId }, guest.cookie);
			expect(accepted.status).toBe(200);
			expect(
				(
					await owner.query(`SELECT cohort_id FROM member WHERE organization_id = $1 AND user_id = $2`, [
						org,
						guest.userId,
					])
				).rows[0],
			).toEqual({ cohort_id: cohort.id });
		});

		it("never passes the seat limit when two confirm calls run at once", async () => {
			const founder = await signUp("race");
			const org = await createOrganization(founder, "starter");
			const ctx = context(founder, org);
			const file = (prefix: string) =>
				csvFile(`email\r\n${[1, 2, 3].map((n) => `${prefix}${n}-${run}@example.test`).join("\r\n")}\r\n`);
			const [first, second] = await Promise.all([
				invoke<InviteReport>(admin.invitations.confirm, { file: file("p") }, ctx),
				invoke<InviteReport>(admin.invitations.confirm, { file: file("q") }, ctx),
			]);
			// Limit 3, the founder holds one: exactly two seats exist for six rows.
			expect(first.sent + second.sent).toBe(2);
			expect(await seatsUsed(org)).toBe(3);
			const refused = [...first.rows, ...second.rows].filter((row) => row.status === "over_seat_limit");
			expect(refused).toHaveLength(4);
		});

		it("refuses a bad file with a clear error and sends nothing", async () => {
			const founder = await signUp("badf");
			const org = await createOrganization(founder, "starter");
			const ctx = context(founder, org);
			await expect(
				invoke(admin.invitations.dryRun, { file: new File([new Uint8Array([0xff, 0xfe, 0x00])], "x.csv") }, ctx),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				data: { code: "CSV_BAD_ENCODING" },
			});
			await expect(invoke(admin.invitations.confirm, { file: csvFile("name\nAda\n") }, ctx)).rejects.toMatchObject({
				code: "BAD_REQUEST",
				data: { code: "CSV_NO_EMAIL_COLUMN" },
			});
			expect(await seatsUsed(org)).toBe(1);
		});

		it("refuses writes of a suspended organization, but still exports", async () => {
			const founder = await signUp("susp");
			const org = await createOrganization(founder, "starter");
			const ctx = context(founder, org);
			await setPlan(org, "starter", "suspended");
			await expect(
				invoke(admin.invitations.confirm, { file: csvFile("email\na@example.test\n") }, ctx),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "ORG_SUSPENDED" },
			});
			await expect(
				invoke(admin.invitations.dryRun, { file: csvFile("email\na@example.test\n") }, ctx),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "ORG_SUSPENDED" },
			});
			await expect(invoke(admin.cohorts.create, { name: "Nope" }, ctx)).rejects.toMatchObject({
				data: { code: "ORG_SUSPENDED" },
			});
			const exported = await invoke<{ body: File }>(admin.analytics.exportSummary, undefined, ctx);
			expect(await exported.body.text()).toContain("members,1");
		});
	});

	// ---- analytics and export ------------------------------------------------------------------------------------
	describe("analytics and export", () => {
		it("counts members, resumes, applications, stages, interviews and offers for a range and a cohort", async () => {
			const founder = await signUp("ana");
			const org = await createOrganization(founder, "pro");
			const ctx = context(founder, org);
			const cohort = await invoke<{ id: string }>(admin.cohorts.create, { name: "Counted" }, ctx);
			const inCohort = await addMember(org, "ana1");
			const outside = await addMember(org, "ana2");
			await invoke(admin.members.setCohort, { memberIds: [inCohort.memberId], cohortId: cohort.id }, ctx);
			// Resumes and applications are tenant rows: seeded by the owner role with an explicit organization.
			const seedResume = (user: string, created: string) =>
				owner.query(
					`INSERT INTO resume (id, name, slug, user_id, organization_id, data, created_at) VALUES ($1, 'r', $1, $2, $3, '{}', $4)`,
					[`res-${randomUUID()}`, user, org, created],
				);
			const seedApp = (user: string, status: string, created: string, reason: string | null = null) =>
				owner.query(
					`INSERT INTO application (id, organization_id, user_id, company, role, status, closed_reason, created_at) VALUES ($1, $2, $3, 'Co', 'Role', $4, $5, $6)`,
					[`app-${randomUUID()}`, org, user, status, reason, created],
				);
			await seedResume(inCohort.userId, "2026-05-10T10:00:00Z");
			await seedResume(inCohort.userId, "2026-01-01T10:00:00Z");
			await seedResume(outside.userId, "2026-05-11T10:00:00Z");
			await seedApp(inCohort.userId, "applied", "2026-05-10T10:00:00Z");
			await seedApp(inCohort.userId, "interview", "2026-05-12T10:00:00Z");
			await seedApp(inCohort.userId, "offer", "2026-05-13T10:00:00Z");
			await seedApp(inCohort.userId, "closed", "2026-05-14T10:00:00Z", "accepted");
			await seedApp(inCohort.userId, "interview", "2026-02-01T10:00:00Z");
			await seedApp(outside.userId, "interview", "2026-05-12T10:00:00Z");
			await owner.query(
				`INSERT INTO session (id, token, user_id, expires_at, active_organization_id, created_at, updated_at) VALUES ($1, $1, $2, now() + interval '1 day', $3, $4, $4)`,
				[`ses-${randomUUID()}`, inCohort.userId, org, "2026-05-12T08:00:00Z"],
			);

			const range = { from: "2026-05-01", to: "2026-05-31" };
			const all = await invoke<Record<string, unknown>>(admin.analytics.summary, range, ctx);
			expect(all).toMatchObject({
				members: 3,
				activeMembers: 1,
				resumesCreated: 2,
				applicationsCreated: 5,
				interviews: 2,
				offers: 2,
				applicationsByStage: { saved: 0, applied: 1, screening: 0, interview: 2, offer: 1, closed: 1 },
				aiCreditsUsed: null,
			});
			const cohortOnly = await invoke<Record<string, unknown>>(
				admin.analytics.summary,
				{ ...range, cohortId: cohort.id },
				ctx,
			);
			expect(cohortOnly).toMatchObject({
				members: 1,
				resumesCreated: 1,
				applicationsCreated: 4,
				interviews: 1,
				offers: 2,
			});

			const table = await invoke<{
				items: {
					memberId: string;
					resumes: number;
					applications: number;
					interviews: number;
					offers: number;
					lastActiveAt: Date | null;
				}[];
				total: number;
			}>(admin.analytics.members, { ...range, sort: "applications", direction: "desc" }, ctx);
			expect(table.total).toBe(3);
			expect(table.items[0]).toMatchObject({
				memberId: inCohort.memberId,
				resumes: 1,
				applications: 4,
				interviews: 1,
				offers: 2,
			});
			expect(table.items[0]?.lastActiveAt).toBeInstanceOf(Date);
			const byName = await invoke<{ items: { name: string }[] }>(
				admin.analytics.members,
				{ ...range, sort: "name", direction: "desc" },
				ctx,
			);
			expect(byName.items.map((item) => item.name)).toEqual(
				byName.items
					.map((item) => item.name)
					.sort()
					.reverse(),
			);
		});

		it("refuses a range longer than 366 days or backwards, and defaults to 30 days", async () => {
			const founder = await signUp("rng");
			const org = await createOrganization(founder, "pro");
			const ctx = context(founder, org);
			await expect(
				invoke(admin.analytics.summary, { from: "2025-01-01", to: "2026-01-02" }, ctx),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			await expect(
				invoke(admin.analytics.summary, { from: "2026-02-02", to: "2026-02-01" }, ctx),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(await invoke(admin.analytics.summary, { from: "2025-01-01", to: "2025-12-31" }, ctx)).toMatchObject({
				members: 1,
			});
			const defaults = await invoke<{ from: string; to: string }>(admin.analytics.summary, undefined, ctx);
			expect((Date.parse(defaults.to) - Date.parse(defaults.from)) / 86_400_000).toBe(29);
		});

		it("pages the members table 50 at a time", async () => {
			const founder = await signUp("pg");
			const org = await createOrganization(founder, "pro");
			const ctx = context(founder, org);
			await Promise.all(Array.from({ length: 54 }, (_, i) => addMember(org, `pg${String(i).padStart(2, "0")}`)));
			const first = await invoke<{ items: unknown[]; total: number; pageSize: number }>(
				admin.analytics.members,
				undefined,
				ctx,
			);
			expect(first).toMatchObject({ total: 55, pageSize: 50 });
			expect(first.items).toHaveLength(50);
			expect((await invoke<{ items: unknown[] }>(admin.analytics.members, { page: 2 }, ctx)).items).toHaveLength(5);
		});

		it("escapes CSV injection cells in the export and writes an audit row with the filters and row count", async () => {
			const founder = await signUp("csv");
			const org = await createOrganization(founder, "pro");
			const ctx = context(founder, org);
			const cohort = await invoke<{ id: string }>(
				admin.cohorts.create,
				{ name: '=HYPERLINK("http://evil.test")' },
				ctx,
			);
			const evil = await addMember(org, "evil", "member", "=cmd|' /C calc'!A0");
			await addMember(org, "evil2", "member", "+SUM(1,1)");
			await addMember(org, "evil3", "member", "-2+3");
			await addMember(org, "evil4", "member", "@SUM(A1)");
			await addMember(org, "evil5", "member", "\tTabbed");
			await invoke(admin.members.setCohort, { memberIds: [evil.memberId], cohortId: cohort.id }, ctx);

			const exported = await invoke<{ headers: Record<string, string>; body: File }>(
				admin.analytics.exportMembers,
				{ from: "2026-01-01", to: "2026-01-31" },
				ctx,
			);
			expect(exported.headers["content-disposition"]).toContain("analytics-members-2026-01-01-to-2026-01-31.csv");
			expect(exported.body.type).toContain("text/csv");
			const text = await exported.body.text();
			const lines = text.split("\r\n").filter(Boolean);
			expect(lines[0]).toBe("name,email,cohort,last active,resumes,applications,interviews,offers");
			expect(lines).toHaveLength(7);
			// No line of data starts a cell with a formula character: each is neutralized with an apostrophe.
			for (const cell of [
				"'=cmd|' /C calc'!A0",
				"'+SUM(1,1)",
				"'-2+3",
				"'@SUM(A1)",
				"'\tTabbed",
				`'=HYPERLINK(""http://evil.test"")`,
			])
				expect(text, cell).toContain(cell);
			expect(text).not.toMatch(/(^|\r\n|,)"?[=+\-@]/);
			const [row] = (
				await owner.query<{ metadata: Record<string, unknown>; actor_user_id: string }>(
					`SELECT metadata, actor_user_id FROM audit_log WHERE organization_id = $1 AND action = 'analytics.exported'`,
					[org],
				)
			).rows;
			expect(row?.actor_user_id).toBe(founder.userId);
			expect(row?.metadata).toEqual({ kind: "members", from: "2026-01-01", to: "2026-01-31", cohortId: null, rows: 6 });

			const summary = await invoke<{ body: File }>(
				admin.analytics.exportSummary,
				{ from: "2026-01-01", to: "2026-01-31", cohortId: cohort.id },
				ctx,
			);
			const summaryText = await summary.body.text();
			expect(summaryText.split("\r\n")[0]).toBe("metric,value");
			expect(summaryText).toContain("members,1");
			expect(
				await count(
					`SELECT count(*) AS n FROM audit_log WHERE organization_id = $1 AND action = 'analytics.exported'`,
					[org],
				),
			).toBe(2);
		});
	});

	// ---- audit view -----------------------------------------------------------------------------------------------
	describe("audit view", () => {
		it("filters the organization's audit log by action", async () => {
			const founder = await signUp("aud");
			const org = await createOrganization(founder, "pro");
			const ctx = context(founder, org);
			await invoke(admin.cohorts.create, { name: "Audited" }, ctx);
			const plain = await addMember(org, "audm");
			await expect(invoke(organization.audit, { action: "cohort.created" }, context(plain, org))).rejects.toMatchObject(
				{ code: "FORBIDDEN" },
			);
			const page = await invoke<{ items: { action: string }[] }>(organization.audit, { action: "cohort.created" }, ctx);
			expect(page.items.map((item) => item.action)).toEqual(["cohort.created"]);
		});
	});
});
