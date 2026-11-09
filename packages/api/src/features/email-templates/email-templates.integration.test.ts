import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { call } from "@orpc/server";
import { Pool } from "pg";

// Real organization scope and real entitlements, not the fixed ones from vitest.org.setup.ts.
vi.mock("@careeros/tenancy", async (importOriginal) => importOriginal());
vi.mock("@careeros/billing", async (importOriginal) => importOriginal());

// P5-T04: email templates per application stage, as the `careeros_app` role on a database of its own with every
// migration applied. Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const PLATFORM = "localhost:3000";

type Entry = {
	id: string;
	source: string;
	kind: string;
	stageCategories: string[];
	name: string;
	subject: string;
	body: string;
};
type Person = { userId: string; email: string };

describe.skipIf(!configured)("Email templates (API)", () => {
	const run = randomUUID().slice(0, 8);
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let router: typeof import("./router").emailTemplatesRouter;

	// ---- helpers ----------------------------------------------------------------------------------------------
	const setPlan = (organizationId: string, plan: string) =>
		owner.query(`SELECT careeros_set_org_plan($1, $2, NULL, NULL, 'test fixture')`, [organizationId, plan]);

	/** An organization on the Pro plan (so its owners and admins have an admin console). */
	const createOrganization = async (label: string) => {
		const id = `org-${label}-${run}`;
		await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [id]);
		await setPlan(id, "pro");
		return id;
	};

	const addMember = async (organizationId: string, label: string, role = "member", name = `${label} Tester`) => {
		const id = `${label}-${run}`;
		await owner.query(
			`INSERT INTO "user" (id, name, email, username, display_username, timezone) VALUES ($1, $2, $1 || '@example.test', $1, $1, 'Africa/Nairobi')`,
			[id, name],
		);
		await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $1, $3)`, [
			id,
			organizationId,
			role,
		]);
		return { userId: id, email: `${id}@example.test` } satisfies Person;
	};

	const context = (person: { userId: string }, organizationId: string) => ({
		authentication: {
			user: { id: person.userId },
			method: "session" as const,
			permissions: ["read", "write", "delete"] as const,
			activeOrganizationId: organizationId,
		},
		reqHeaders: new Headers({ host: PLATFORM, origin: `http://${PLATFORM}` }),
		locale: "en-US",
	});
	const invoke = <T>(procedure: unknown, input: unknown, ctx: unknown): Promise<T> =>
		call(procedure as never, input as never, { context: ctx as never }) as Promise<T>;

	const as = (person: Person, organizationId: string) => {
		const ctx = context(person, organizationId);
		return {
			list: () => invoke<Entry[]>(router.list, undefined, ctx),
			create: (input: Record<string, unknown>) => invoke<Entry>(router.create, input, ctx),
			update: (input: Record<string, unknown>) => invoke<Entry>(router.update, input, ctx),
			archive: (id: string) => invoke<{ id: string }>(router.archive, { id }, ctx),
			orgCreate: (input: Record<string, unknown>) => invoke<Entry>(router.orgCreate, input, ctx),
			orgUpdate: (input: Record<string, unknown>) => invoke<Entry>(router.orgUpdate, input, ctx),
			orgArchive: (id: string) => invoke<{ id: string }>(router.orgArchive, { id }, ctx),
			render: (input: Record<string, unknown>) =>
				invoke<{ subject: string; body: string; to: string | null; missing: string[] }>(router.render, input, ctx),
		};
	};

	const fields = (patch: Record<string, unknown> = {}) => ({
		kind: "custom",
		stageCategory: null,
		name: "Mine",
		subject: "Hello {{company}}",
		body: "Dear {{contactName}},\n{{firstName}}",
		...patch,
	});

	const addApplication = async (organizationId: string, userId: string, patch: Record<string, unknown> = {}) => {
		const id = `app-${randomUUID().slice(0, 8)}`;
		const values = {
			company: "Acme",
			role: "Designer",
			contacts: [{ name: "Sam Rivera", role: "Recruiter", type: "", email: "sam@acme.test", phone: "" }],
			activity: [
				{
					id: "i1",
					type: "interview",
					at: "2099-01-20T09:30:00.000Z",
					kind: "onsite",
					durationMinutes: 60,
					location: "",
					notes: "",
					participants: [],
					audience: "other",
					timezone: "UTC",
				},
			],
			...patch,
		};
		await owner.query(
			`INSERT INTO application (id, organization_id, user_id, company, role, contacts, activity) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[
				id,
				organizationId,
				userId,
				values.company,
				values.role,
				JSON.stringify(values.contacts),
				JSON.stringify(values.activity),
			],
		);
		return id;
	};

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("emailtpl_t04");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.APP_URL = `http://${PLATFORM}`;
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		({ emailTemplatesRouter: router } = await import("./router"));
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	// ---- row-level security ---------------------------------------------------------------------------------------
	describe("email_template table", () => {
		it("is row-level secured: the app role sees and writes only the current organization's templates", async () => {
			const orgA = await createOrganization("rlsa");
			const orgB = await createOrganization("rlsb");
			await owner.query(
				`INSERT INTO email_template (id, organization_id, kind, name, subject, body)
				 VALUES ($1, $2, 'custom', 'A', 's', 'b'), ($3, $4, 'custom', 'B', 's', 'b')`,
				[`rls-a-${run}`, orgA, `rls-b-${run}`, orgB],
			);
			const client = await app.connect();
			try {
				expect((await client.query(`SELECT id FROM email_template`)).rowCount).toBe(0);
				await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgA]);
				expect((await client.query<{ id: string }>(`SELECT id FROM email_template`)).rows.map((row) => row.id)).toEqual(
					[`rls-a-${run}`],
				);
				await expect(
					client.query(
						`INSERT INTO email_template (id, organization_id, kind, name, subject, body) VALUES ('forged', $1, 'custom', 'x', 'x', 'x')`,
						[orgB],
					),
				).rejects.toThrow(/row-level security/);
				expect(
					(await client.query(`UPDATE email_template SET name = 'x' WHERE id = $1`, [`rls-b-${run}`])).rowCount,
				).toBe(0);
				expect((await client.query(`DELETE FROM email_template WHERE id = $1`, [`rls-b-${run}`])).rowCount).toBe(0);
			} finally {
				await client.query(`SELECT set_config('app.current_org_id', '', false)`);
				client.release();
			}
		});

		it("has row-level security enabled and forced, with the tenant_isolation policy", async () => {
			const table = (
				await owner.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'email_template'`)
			).rows[0];
			expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
			const policies = (
				await owner.query<{ policyname: string }>(
					`SELECT policyname FROM pg_policies WHERE tablename = 'email_template'`,
				)
			).rows;
			expect(policies.map((row) => row.policyname)).toContain("tenant_isolation");
		});

		it("refuses text past the limits and an unknown kind or stage", async () => {
			const org = await createOrganization("chk");
			const insert = (kind: string, stage: string | null, body: string) =>
				owner.query(
					`INSERT INTO email_template (id, organization_id, kind, stage_category, name, subject, body) VALUES ($1, $2, $3, $4, 'n', 's', $5)`,
					[`chk-${randomUUID()}`, org, kind, stage, body],
				);
			await expect(insert("custom", null, "x".repeat(10_001))).rejects.toThrow(/email_template_body_check/);
			await expect(insert("bulk", null, "x")).rejects.toThrow(/email_template_kind_check/);
			await expect(insert("custom", "ghosted", "x")).rejects.toThrow(/email_template_stage_check/);
			await expect(insert("custom", "offer", "x".repeat(10_000))).resolves.toBeDefined();
		});
	});

	// ---- the list: mine, the organization's, the built-ins ------------------------------------------------------------
	describe("list", () => {
		it("offers the four built-ins when the organization has customised nothing", async () => {
			const org = await createOrganization("lb");
			const member = await addMember(org, "lbm");
			const list = await as(member, org).list();
			expect(list.map((entry) => entry.source)).toEqual(["builtin", "builtin", "builtin", "builtin"]);
			expect(list.map((entry) => entry.id).sort()).toEqual([
				"builtin:follow_up",
				"builtin:negotiation",
				"builtin:networking",
				"builtin:thank_you",
			]);
		});

		it("replaces the built-in of a kind with the organization's default, and brings it back when that is archived", async () => {
			const org = await createOrganization("lo");
			const admin = await addMember(org, "loa", "admin");
			const member = await addMember(org, "lom");
			const created = await as(admin, org).orgCreate(
				fields({ kind: "follow_up", name: "Our follow-up", stageCategory: "applied" }),
			);
			expect(created).toMatchObject({ source: "org", kind: "follow_up", stageCategories: ["applied"] });

			const seen = await as(member, org).list();
			expect(seen.find((entry) => entry.kind === "follow_up")).toMatchObject({
				id: created.id,
				source: "org",
				name: "Our follow-up",
			});
			expect(seen.filter((entry) => entry.kind === "follow_up")).toHaveLength(1);
			expect(seen).toHaveLength(4);

			await as(admin, org).orgArchive(created.id);
			const after = await as(member, org).list();
			expect(after.find((entry) => entry.kind === "follow_up")).toMatchObject({
				id: "builtin:follow_up",
				source: "builtin",
			});
		});

		it("lists a member's own templates, and only theirs", async () => {
			const org = await createOrganization("lm");
			const one = await addMember(org, "lm1");
			const two = await addMember(org, "lm2");
			const mine = await as(one, org).create(fields({ name: "Only for one" }));
			expect(mine).toMatchObject({ source: "mine", name: "Only for one" });
			expect((await as(one, org).list()).map((entry) => entry.id)).toContain(mine.id);
			expect((await as(two, org).list()).map((entry) => entry.id)).not.toContain(mine.id);
			// An admin of the organization has no way to read it either.
			const admin = await addMember(org, "lm3", "owner");
			expect((await as(admin, org).list()).map((entry) => entry.id)).not.toContain(mine.id);
		});
	});

	// ---- who writes what -------------------------------------------------------------------------------------------
	describe("writes", () => {
		it("lets a member write only their own templates, never the organization's defaults", async () => {
			const org = await createOrganization("wm");
			const admin = await addMember(org, "wma", "owner");
			const member = await addMember(org, "wmm");
			const def = await as(admin, org).orgCreate(fields({ name: "Default" }));

			const asMember = as(member, org);
			await expect(asMember.orgCreate(fields())).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "ORG_ADMIN_REQUIRED" },
			});
			await expect(asMember.orgUpdate({ id: def.id, name: "Hijacked" })).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(asMember.orgArchive(def.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
			// The member's own-template procedures cannot reach a default either.
			await expect(asMember.update({ id: def.id, name: "Hijacked" })).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(asMember.archive(def.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
			const row = (await owner.query(`SELECT name, archived_at FROM email_template WHERE id = $1`, [def.id])).rows[0];
			expect(row).toEqual({ name: "Default", archived_at: null });
		});

		it("refuses a personal workspace's owner the organization procedures", async () => {
			const org = `org-personal-${run}`;
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
			const person = await addMember(org, "pw", "owner");
			expect((await owner.query(`SELECT plan_id FROM organization WHERE id = $1`, [org])).rows[0]).toEqual({
				plan_id: "personal",
			});
			await expect(as(person, org).orgCreate(fields())).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "PERSONAL_WORKSPACE" },
			});
		});

		it("does not let a member read, change, archive or render another member's template", async () => {
			const org = await createOrganization("wo");
			const one = await addMember(org, "wo1");
			const two = await addMember(org, "wo2");
			const theirs = await as(one, org).create(fields({ name: "Private" }));
			const application = await addApplication(org, two.userId);

			const asTwo = as(two, org);
			await expect(asTwo.update({ id: theirs.id, name: "Stolen" })).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(asTwo.archive(theirs.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(asTwo.render({ templateId: theirs.id, applicationId: application })).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(
				(await owner.query(`SELECT name, archived_at FROM email_template WHERE id = $1`, [theirs.id])).rows[0],
			).toEqual({
				name: "Private",
				archived_at: null,
			});
		});

		it("takes the organization and the owner from the request, never from the input", async () => {
			const orgA = await createOrganization("owa");
			const orgB = await createOrganization("owb");
			const member = await addMember(orgA, "owm");
			const entry = await as(member, orgA).create({ ...fields(), organizationId: orgB, userId: "someone-else" });
			const row = (await owner.query(`SELECT organization_id, user_id FROM email_template WHERE id = $1`, [entry.id]))
				.rows[0];
			expect(row).toEqual({ organization_id: orgA, user_id: member.userId });
		});

		it("updates and archives a member's own template; an archived one is gone from the list and cannot be changed", async () => {
			const org = await createOrganization("ua");
			const member = await addMember(org, "uam");
			const entry = await as(member, org).create(fields({ name: "Before", stageCategory: "offer" }));
			const updated = await as(member, org).update({
				id: entry.id,
				name: "After",
				stageCategory: null,
				subject: "New {{role}}",
			});
			expect(updated).toMatchObject({ name: "After", subject: "New {{role}}", stageCategories: [] });
			await as(member, org).archive(entry.id);
			expect((await as(member, org).list()).map((item) => item.id)).not.toContain(entry.id);
			await expect(as(member, org).update({ id: entry.id, name: "Zombie" })).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(as(member, org).archive(entry.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		it("validates the text: limits, kind, stage", async () => {
			const org = await createOrganization("val");
			const member = await addMember(org, "valm");
			const asMember = as(member, org);
			await expect(asMember.create(fields({ body: "x".repeat(10_001) }))).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			await expect(asMember.create(fields({ name: "   " }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
			await expect(asMember.create(fields({ kind: "bulk" }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
			await expect(asMember.create(fields({ stageCategory: "ghosted" }))).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			await expect(asMember.create(fields({ body: "x".repeat(10_000) }))).resolves.toMatchObject({ source: "mine" });
		});
	});

	// ---- other organizations -----------------------------------------------------------------------------------------
	describe("another organization", () => {
		it("never sees, changes, archives or renders an organization's templates", async () => {
			const orgA = await createOrganization("xa");
			const orgB = await createOrganization("xb");
			const adminA = await addMember(orgA, "xaa", "owner");
			const memberA = await addMember(orgA, "xam");
			const adminB = await addMember(orgB, "xba", "owner");
			const memberB = await addMember(orgB, "xbm");
			const marker = `xorg-${run}`;
			const defaultA = await as(adminA, orgA).orgCreate(
				fields({ name: `${marker} default`, subject: `${marker} subject`, body: `${marker} body` }),
			);
			const mineA = await as(memberA, orgA).create(fields({ name: `${marker} mine`, body: `${marker} body` }));
			const applicationB = await addApplication(orgB, memberB.userId);

			for (const actor of [adminB, memberB]) {
				const list = await as(actor, orgB).list();
				expect(JSON.stringify(list)).not.toContain(marker);
				expect(list.every((entry) => entry.source === "builtin")).toBe(true);
			}
			for (const id of [defaultA.id, mineA.id]) {
				await expect(as(memberB, orgB).update({ id, name: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
				await expect(as(memberB, orgB).archive(id)).rejects.toMatchObject({ code: "NOT_FOUND" });
				await expect(as(adminB, orgB).orgUpdate({ id, name: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
				await expect(as(adminB, orgB).orgArchive(id)).rejects.toMatchObject({ code: "NOT_FOUND" });
				await expect(as(memberB, orgB).render({ templateId: id, applicationId: applicationB })).rejects.toMatchObject({
					code: "NOT_FOUND",
				});
			}
			const rows = (
				await owner.query(`SELECT id, name, archived_at FROM email_template WHERE organization_id = $1 ORDER BY id`, [
					orgA,
				])
			).rows;
			expect(rows.every((row) => row.archived_at === null && String(row.name).startsWith(marker))).toBe(true);
			// And B's own writes land in B.
			const created = await as(adminB, orgB).orgCreate(fields({ name: "B default" }));
			expect(
				(await owner.query(`SELECT organization_id FROM email_template WHERE id = $1`, [created.id])).rows[0],
			).toEqual({
				organization_id: orgB,
			});
		});
	});

	// ---- render ------------------------------------------------------------------------------------------------------------
	describe("render", () => {
		it("fills a built-in in from the caller's application: the contact, the company, the role, the interview date", async () => {
			const org = await createOrganization("rf");
			const member = await addMember(org, "rfm", "member", "Amina Otieno");
			const application = await addApplication(org, member.userId);
			const out = await as(member, org).render({
				templateId: "builtin:thank_you",
				applicationId: application,
				locale: "en",
			});
			expect(out.subject).toBe("Thank you for meeting with me on Tuesday, January 20 at 12:30 PM");
			expect(out.body).toContain("Hello Sam Rivera,");
			expect(out.body).toContain("the Designer role at Acme");
			expect(out.body).toContain("Amina Otieno");
			expect(out.body).toContain(member.email);
			expect(out.to).toBe("sam@acme.test");
			expect(out.missing).toEqual([]);
		});

		it("turns a missing value into a visible placeholder and says which", async () => {
			const org = await createOrganization("rm");
			const member = await addMember(org, "rmm");
			const application = await addApplication(org, member.userId, { contacts: [], activity: [] });
			const out = await as(member, org).render({ templateId: "builtin:thank_you", applicationId: application });
			expect(out.subject).toBe("Thank you for meeting with me on [interviewDate]");
			expect(out.body).toContain("Hello [contactName],");
			expect(out.to).toBeNull();
			expect(out.missing).toEqual(expect.arrayContaining(["contactName", "interviewDate"]));
		});

		it("fills a stored template, leaves unknown variables as typed, and never runs anything", async () => {
			const org = await createOrganization("rs");
			const member = await addMember(org, "rsm");
			const entry = await as(member, org).create(
				fields({ subject: "{{company}} <b>{{nickname}}</b>", body: "${1+1} {{role}} {{ company }} {{constructor}}" }),
			);
			const application = await addApplication(org, member.userId, { company: "Acme <script>" });
			const out = await as(member, org).render({ templateId: entry.id, applicationId: application });
			expect(out.subject).toBe("Acme <script> <b>{{nickname}}</b>");
			expect(out.body).toBe("${1+1} Designer Acme <script> {{constructor}}");
		});

		it("uses an organization default for a member of that organization", async () => {
			const org = await createOrganization("rd");
			const admin = await addMember(org, "rda", "admin");
			const member = await addMember(org, "rdm");
			const def = await as(admin, org).orgCreate(fields({ subject: "From the school: {{role}}", body: "Hi" }));
			const application = await addApplication(org, member.userId);
			expect((await as(member, org).render({ templateId: def.id, applicationId: application })).subject).toBe(
				"From the school: Designer",
			);
		});

		it("refuses another member's application, and one that does not exist", async () => {
			const org = await createOrganization("rr");
			const one = await addMember(org, "rr1");
			const two = await addMember(org, "rr2");
			const theirs = await addApplication(org, two.userId);
			await expect(
				as(one, org).render({ templateId: "builtin:follow_up", applicationId: theirs }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				as(one, org).render({ templateId: "builtin:follow_up", applicationId: "nope" }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(as(one, org).render({ templateId: "builtin:nope", applicationId: theirs })).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("refuses another organization's application", async () => {
			const orgA = await createOrganization("rxa");
			const orgB = await createOrganization("rxb");
			const memberA = await addMember(orgA, "rxam");
			const memberB = await addMember(orgB, "rxbm");
			const applicationB = await addApplication(orgB, memberB.userId);
			await expect(
				as(memberA, orgA).render({ templateId: "builtin:follow_up", applicationId: applicationB }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		it("takes a translated source only for a built-in", async () => {
			const org = await createOrganization("rt");
			const member = await addMember(org, "rtm");
			const application = await addApplication(org, member.userId);
			const source = { subject: "Re: {{role}}", body: "Bonjour {{contactName}}" };
			const out = await as(member, org).render({ templateId: "builtin:follow_up", applicationId: application, source });
			expect(out).toMatchObject({ subject: "Re: Designer", body: "Bonjour Sam Rivera" });
			const stored = await as(member, org).create(fields());
			await expect(
				as(member, org).render({ templateId: stored.id, applicationId: application, source }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});
	});

	// ---- audit -------------------------------------------------------------------------------------------------------
	describe("audit", () => {
		it("writes one row per change to an organization default, with ids and counts only", async () => {
			const org = await createOrganization("au");
			const admin = await addMember(org, "aua", "owner");
			const secret = `never-in-the-audit-${run}`;
			const entry = await as(admin, org).orgCreate(fields({ name: secret, subject: secret, body: secret }));
			await as(admin, org).orgUpdate({ id: entry.id, body: `${secret} again`, name: `${secret} two` });
			await as(admin, org).orgArchive(entry.id);
			// A member's own templates are not an organization change and write no row.
			await as(await addMember(org, "aum"), org).create(fields({ name: secret }));
			const rows = (
				await owner.query<{ action: string; target_id: string; actor_user_id: string; metadata: unknown }>(
					`SELECT action, target_id, actor_user_id, metadata FROM audit_log WHERE organization_id = $1 AND action LIKE 'email_template.%' ORDER BY created_at`,
					[org],
				)
			).rows;
			expect(rows.map((row) => row.action)).toEqual([
				"email_template.org_created",
				"email_template.org_updated",
				"email_template.org_archived",
			]);
			expect(rows.every((row) => row.target_id === entry.id && row.actor_user_id === admin.userId)).toBe(true);
			expect(rows[1]?.metadata).toEqual({ fieldCount: 2 });
			expect(JSON.stringify(rows)).not.toContain(secret);
		});
	});
});
