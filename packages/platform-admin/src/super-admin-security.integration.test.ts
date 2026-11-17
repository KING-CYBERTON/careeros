import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool, type PoolClient } from "pg";

// P3-Q03: the Super Admin console's database layer, attacked. Every function the service calls is found in the service's
// source (so a new one is covered automatically), and each must be a SECURITY DEFINER with a pinned search_path, revoked
// from PUBLIC, executable by `careeros_app` alone, and must refuse a non-admin actor before it reads or writes anything.
// Then the audit log: append-only for the app role, one console row per action with who, what, where and when, and
// visible to an organization only for that organization. Real Postgres with every migration applied; the app role is the
// real NOSUPERUSER, NOBYPASSRLS `careeros_app`. Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Every `careeros_*` function named inside an `sql` template of the service's source (not its tests). */
function functionsCalledByService(): string[] {
	const directory = new URL(".", import.meta.url);
	const found = new Set<string>();
	for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts") && !name.includes(".test."))) {
		const source = readFileSync(new URL(file, directory), "utf8");
		for (const template of source.matchAll(/sql`([^`]*)`/g))
			for (const call of (template[1] ?? "").matchAll(/\b(careeros_[a-z0-9_]+)\s*\(/g)) found.add(call[1] as string);
	}
	return [...found].sort();
}

/** The SQL text of every `sql` template of the service's source. */
function serviceSql(): { file: string; text: string }[] {
	const directory = new URL(".", import.meta.url);
	const out: { file: string; text: string }[] = [];
	for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts") && !name.includes(".test."))) {
		const source = readFileSync(new URL(file, directory), "utf8");
		for (const template of source.matchAll(/sql`([^`]*)`/g)) out.push({ file, text: template[1] ?? "" });
	}
	return out;
}

describe.skipIf(!configured)("Super Admin security: definer functions and the audit log", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		admin: `q03-admin-${run}`,
		adminNo2fa: `q03-admin-no2fa-${run}`,
		bannedAdmin: `q03-banned-admin-${run}`,
		plain: `q03-plain-${run}`,
		lookalike: `q03-lookalike-${run}`,
		superadmin: `q03-superadmin-${run}`,
		upper: `q03-upper-${run}`,
		ownerA: `q03-owner-a-${run}`,
		memberA: `q03-member-a-${run}`,
		ownerB: `q03-owner-b-${run}`,
		unknown: `q03-nobody-${run}`,
	};
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let probeRole: string;
	let counter = 0;
	let orgA: string;
	let orgB: string;

	const one = <T>(rows: T[]): T => {
		const row = rows[0];
		if (row === undefined) throw new Error("expected a row");
		return row;
	};
	const ownerRows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
		(await owner.query<T>(sql, params)).rows;
	const newOrg = async (name: string, members: [string, string][]) => {
		const id = `q03-org-${run}-${++counter}`;
		await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $1)`, [id, name]);
		for (const [userId, role] of members)
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
				`m-${id}-${userId}`,
				id,
				userId,
				role,
			]);
		return id;
	};
	const dbNow = async () => one(await ownerRows<{ now: Date }>(`SELECT clock_timestamp() AS now`)).now;
	type AuditRow = {
		id: string;
		organization_id: string | null;
		actor_user_id: string | null;
		action: string;
		target_type: string | null;
		target_id: string | null;
		metadata: Record<string, unknown>;
		created_at: Date;
	};
	const auditSince = (since: Date) =>
		ownerRows<AuditRow>(
			`SELECT id, organization_id, actor_user_id, action, target_type, target_id, metadata, created_at
			 FROM audit_log WHERE created_at >= $1 ORDER BY created_at, id`,
			[since],
		);
	/** Everything a refused call must leave as it was. */
	const state = async () =>
		(
			await ownerRows<Record<string, string>>(`SELECT
				(SELECT count(*) FROM audit_log)::text AS audit,
				(SELECT count(*) FROM announcement)::text AS announcements,
				(SELECT count(*) FROM impersonation)::text AS impersonations,
				(SELECT md5(coalesce(string_agg(o::text, '|' ORDER BY o.id), '')) FROM organization o) AS organizations,
				(SELECT md5(coalesce(string_agg(s::text, '|' ORDER BY s.organization_id), '')) FROM subscription s) AS subscriptions,
				(SELECT count(*) FROM billing_event)::text AS billing_events`)
		).at(0) ?? ({} as Record<string, string>);

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("sa_defs_q03");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		probeRole = `careeros_q03_probe_${run}`;
		const users: [string, string, boolean, boolean][] = [
			[ids.admin, "admin", true, false],
			[ids.adminNo2fa, "admin", false, false],
			[ids.bannedAdmin, "admin", true, true],
			[ids.plain, "user", true, false],
			// Roles that merely look like the admin role must not count.
			[ids.lookalike, "administrator", true, false],
			[ids.superadmin, "superadmin,owner", true, false],
			[ids.upper, "Admin", true, false],
			[ids.ownerA, "user", false, false],
			[ids.memberA, "user", false, false],
			[ids.ownerB, "user", false, false],
		];
		for (const [id, role, twoFactor, banned] of users)
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username, role, two_factor_enabled, banned) VALUES ($1, $2, $1 || '@example.test', $1, $1, $3, $4, $5)`,
				[id, `Name of ${id}`, role, twoFactor, banned],
			);
		orgA = await newOrg("Acme Coaching", [
			[ids.ownerA, "owner"],
			[ids.memberA, "member"],
		]);
		orgB = await newOrg("Beta Careers", [[ids.ownerB, "owner"]]);
		await owner.query(`CREATE ROLE "${probeRole}" NOLOGIN`);
	}, 180_000);

	afterAll(async () => {
		await owner?.query(`DROP ROLE IF EXISTS "${probeRole}"`).catch(() => undefined);
		await owner?.end();
		await app?.end();
		await database?.drop();
	});

	// One valid call per function that takes an actor, as direct SQL, so a refusal is the function's and a success proves
	// the call was valid. `ctx` carries rows the earlier steps made.
	type Ctx = { org: string; target: string; token: string; announcement: string };
	type Call = (actor: string, ctx: Ctx) => { text: string; values: unknown[] };
	const T = (...casts: string[]) => casts.map((cast, index) => `$${index + 1}::${cast}`).join(", ");
	const calls: Record<string, Call> = {
		careeros_assert_platform_admin: (actor) => ({
			text: `SELECT careeros_assert_platform_admin(${T("text")})`,
			values: [actor],
		}),
		careeros_admin_list_orgs: (actor) => ({
			text: `SELECT * FROM careeros_admin_list_orgs(${T("text", "text", "text", "text", "integer", "integer")})`,
			values: [actor, null, null, null, 10, 0],
		}),
		careeros_admin_get_org: (actor, ctx) => ({
			text: `SELECT careeros_admin_get_org(${T("text", "text")})`,
			values: [actor, ctx.org],
		}),
		careeros_admin_set_org_status: (actor, ctx) => ({
			text: `SELECT careeros_admin_set_org_status(${T("text", "text", "text", "text")})`,
			values: [actor, ctx.org, "suspended", "security test: suspend"],
		}),
		careeros_admin_set_org_plan: (actor, ctx) => ({
			text: `SELECT careeros_admin_set_org_plan(${T("text", "text", "text", "integer", "text")})`,
			values: [actor, ctx.org, "starter", 4, "security test: plan"],
		}),
		careeros_admin_set_ai_overage: (actor, ctx) => ({
			text: `SELECT careeros_admin_set_ai_overage(${T("text", "text", "boolean", "text")})`,
			values: [actor, ctx.org, true, "security test: overage"],
		}),
		careeros_admin_record_manual_payment: (actor, ctx) => ({
			text: `SELECT careeros_admin_record_manual_payment(${T("text", "text", "text", "integer", "text", "timestamptz", "timestamptz", "bigint", "text", "text")})`,
			values: [
				actor,
				ctx.org,
				"starter",
				4,
				"month",
				"2026-11-01T00:00:00Z",
				"2026-12-01T00:00:00Z",
				4900,
				"USD",
				`ref-${run}-${actor}`,
			],
		}),
		careeros_admin_metrics: (actor) => ({
			text: `SELECT careeros_admin_metrics(${T("text", "timestamptz", "timestamptz")})`,
			values: [actor, null, null],
		}),
		careeros_admin_list_audit: (actor) => ({
			text: `SELECT * FROM careeros_admin_list_audit(${T("text", "text", "boolean", "text", "timestamptz", "timestamptz", "text", "integer")})`,
			values: [actor, null, false, null, null, null, null, 10],
		}),
		careeros_admin_announcement_save: (actor) => ({
			text: `SELECT careeros_admin_announcement_save(${T("text", "text", "text", "text", "text", "timestamptz", "timestamptz", "text", "text")})`,
			values: [
				actor,
				null,
				"Security test",
				"Plain text",
				"info",
				new Date(Date.now() - 1000),
				new Date(Date.now() + 3_600_000),
				null,
				null,
			],
		}),
		careeros_admin_announcement_list: (actor) => ({
			text: `SELECT * FROM careeros_admin_announcement_list(${T("text")})`,
			values: [actor],
		}),
		careeros_admin_announcement_end: (actor, ctx) => ({
			text: `SELECT careeros_admin_announcement_end(${T("text", "text")})`,
			values: [actor, ctx.announcement],
		}),
		careeros_admin_impersonation_start: (actor, ctx) => ({
			text: `SELECT * FROM careeros_admin_impersonation_start(${T("text", "text", "text", "text", "text", "text")})`,
			values: [actor, ctx.target, ctx.org, "security test: support", "https://acme.orgs.test", sha256(ctx.token)],
		}),
	};
	const ctx = (): Ctx => ({
		org: orgA,
		target: ids.memberA,
		token: `token-${run}-${counter}`,
		announcement: `none-${run}`,
	});

	// The functions the service calls that have no actor argument: reached with a session id, a user's own id or a token,
	// never by an admin. They are listed so that a new one has to be placed in a category on purpose.
	const NO_ACTOR = new Set([
		"careeros_announcements_for_member",
		"careeros_announcement_dismiss",
		"careeros_impersonation_redeem",
		"careeros_impersonation_attach_session",
		"careeros_impersonation_active",
		"careeros_impersonation_for_session",
		"careeros_impersonation_end",
		"careeros_impersonation_expire_due",
	]);

	type Proc = {
		oid: number;
		proname: string;
		prosecdef: boolean;
		proconfig: string[] | null;
		owner: string;
		args: string[] | null;
		identity: string;
		grantees: string[];
	};
	// Called inside the database by the functions above (never by the service itself): held to the same rules.
	const HELPERS = ["careeros_is_platform_admin"];
	const loadProcs = async (names: string[]) =>
		ownerRows<Proc>(
			`SELECT p.oid::int AS oid, p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
			        p.proargnames AS args, pg_get_function_identity_arguments(p.oid) AS identity,
			        coalesce(ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
			                       FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
			                       WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)::text[], '{}'::text[]) AS grantees
			 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			 WHERE n.nspname = 'public' AND p.proname = ANY ($1) ORDER BY p.proname, p.oid`,
			[names],
		);

	describe("which functions the service calls", () => {
		it("finds them in the service's source and in the catalog, and nothing is missing from either", async () => {
			const called = functionsCalledByService();
			expect(called.length, "the scan found the service's functions").toBeGreaterThanOrEqual(20);
			const procs = await loadProcs(called);
			const present = new Set(procs.map((proc) => proc.proname));
			expect(
				called.filter((name) => !present.has(name)),
				"called but not in the database",
			).toEqual([]);

			// Every console function the migration created is called by the service, bar the two pure helpers.
			const created = (
				await ownerRows<{ proname: string }>(
					`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
					 WHERE n.nspname = 'public' AND (proname LIKE 'careeros\\_admin\\_%' OR proname LIKE 'careeros\\_impersonation\\_%'
					   OR proname LIKE 'careeros\\_announcement%')`,
				)
			).map((row) => row.proname);
			expect(created.filter((name) => !called.includes(name) && name !== "careeros_admin_check_reason")).toEqual([]);
		});

		it("splits into functions with an admin actor (each has a test call) and the few without one (each is listed)", async () => {
			const called = functionsCalledByService();
			const procs = await loadProcs(called);
			const withActor = procs.filter((proc) => proc.args?.[0] === "p_actor").map((proc) => proc.proname);
			const without = procs.filter((proc) => proc.args?.[0] !== "p_actor").map((proc) => proc.proname);
			expect(without.sort()).toEqual([...NO_ACTOR].sort());
			expect(withActor.sort(), "every actor function has a call in this suite").toEqual(Object.keys(calls).sort());
		});

		it("touches no table itself: the service's SQL only ever calls functions", () => {
			const statements = serviceSql();
			expect(statements.length).toBeGreaterThan(20);
			const offending = statements
				.filter(
					({ text }) =>
						/\b(insert\s+into|update\s+\S+\s+set|delete\s+from|truncate)\b/i.test(text) ||
						[...text.matchAll(/\bfrom\s+([a-z_."]+)/gi)].some((match) => !(match[1] ?? "").startsWith("careeros_")),
				)
				.map(({ file, text }) => `${file}: ${text.trim().slice(0, 80)}`);
			expect(offending).toEqual([]);
		});
	});

	describe("every function: definer, pinned search_path, revoked from PUBLIC, executable by careeros_app only", () => {
		it("is SECURITY DEFINER with search_path = pg_catalog, public", async () => {
			const procs = await loadProcs([...functionsCalledByService(), ...HELPERS]);
			for (const proc of procs) {
				expect(proc.prosecdef, `${proc.proname} is SECURITY DEFINER`).toBe(true);
				expect(proc.proconfig, `${proc.proname} pins search_path`).toEqual(["search_path=pg_catalog, public"]);
				expect(proc.owner, `${proc.proname} is not owned by the app role`).not.toBe("careeros_app");
			}
		});

		it("has EXECUTE for nobody but its owner and careeros_app, and PUBLIC cannot run it", async () => {
			const procs = await loadProcs([...functionsCalledByService(), ...HELPERS]);
			for (const proc of procs) {
				expect(proc.grantees.filter((grantee) => grantee !== proc.owner).sort(), proc.proname).toEqual([
					"careeros_app",
				]);
				const [row] = await ownerRows<{ ok: boolean }>(`SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS ok`, [
					probeRole,
					proc.oid,
				]);
				expect(row?.ok, `${proc.proname}: a role with no grant cannot execute it`).toBe(false);
			}
		});

		it("refuses a role that was never granted it, when it actually calls it", async () => {
			const client = await owner.connect();
			try {
				await client.query(`SET ROLE "${probeRole}"`);
				for (const [name, build] of Object.entries(calls)) {
					const { text, values } = build(ids.admin, ctx());
					await expect(client.query(text, values), name).rejects.toMatchObject({ code: "42501" });
					await client.query("ROLLBACK").catch(() => undefined);
				}
			} finally {
				await client.query("RESET ROLE").catch(() => undefined);
				client.release();
			}
		});

		it("keeps careeros_app without BYPASSRLS, superuser or any way to become the owner", async () => {
			const [role] = await ownerRows<Record<string, unknown>>(
				`SELECT rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = 'careeros_app'`,
			);
			expect(role).toEqual({
				rolbypassrls: false,
				rolsuper: false,
				rolcreaterole: false,
				rolcreatedb: false,
				rolreplication: false,
			});
			const [member] = await ownerRows<{ ok: boolean }>(
				`SELECT bool_or(pg_has_role('careeros_app', r.oid, 'MEMBER')) AS ok FROM pg_roles r WHERE r.rolname <> 'careeros_app' AND (r.rolsuper OR r.rolbypassrls OR r.rolname = 'careeros_owner')`,
			);
			expect(member?.ok, "careeros_app is not a member of a superuser, a BYPASSRLS role or careeros_owner").toBe(false);
			const tables = await ownerRows<{
				relname: string;
				owner: string;
				relrowsecurity: boolean;
				relforcerowsecurity: boolean;
			}>(
				`SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity
				 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('audit_log', 'impersonation', 'announcement', 'announcement_dismissal')`,
			);
			expect(tables).toHaveLength(4);
			for (const table of tables) {
				expect(table.owner, `${table.relname} is not owned by the app role`).not.toBe("careeros_app");
				expect(table.relrowsecurity && table.relforcerowsecurity, `${table.relname} forces RLS`).toBe(true);
			}
		});
	});

	describe("every function refuses a non-admin actor, writes nothing and changes nothing", () => {
		const refused: [string, string, RegExp][] = [
			["a plain user", ids.plain, /not a platform admin/],
			["an organization owner", ids.ownerA, /not a platform admin/],
			["a banned platform admin", ids.bannedAdmin, /not a platform admin/],
			["a platform admin without 2FA", ids.adminNo2fa, /two-factor authentication is required/],
			["a role that only looks like admin (administrator)", ids.lookalike, /not a platform admin/],
			["a role that contains admin as a substring (superadmin)", ids.superadmin, /not a platform admin/],
			["a role in another case (Admin)", ids.upper, /not a platform admin/],
			["an actor id that does not exist", ids.unknown, /not a platform admin/],
			["an empty actor id", "", /not a platform admin/],
		];
		for (const [who, actor, message] of refused)
			it(`raises for ${who} on every function, called directly as careeros_app`, async () => {
				const before = await state();
				for (const [name, build] of Object.entries(calls)) {
					const { text, values } = build(actor, ctx());
					await expect(app.query(text, values), `${name} as ${who}`).rejects.toMatchObject({
						code: "42501",
						message: expect.stringMatching(message),
					});
				}
				expect(await state(), `${who} changed something`).toEqual(before);
			});

		it("raises for a missing (NULL) actor on every function", async () => {
			const before = await state();
			for (const [name, build] of Object.entries(calls)) {
				const { text, values } = build(ids.admin, ctx());
				await expect(app.query(text, [null, ...values.slice(1)]), name).rejects.toMatchObject({ code: "42501" });
			}
			expect(await state()).toEqual(before);
		});

		it("is not a gate that refuses everyone: the same calls succeed for the real admin (each is a real, valid call)", async () => {
			for (const [name, build] of Object.entries(calls)) {
				const org = await newOrg(`Valid ${name}`, [
					[ids.ownerA, "owner"],
					[ids.memberA, "member"],
				]);
				const announcement =
					(
						await ownerRows<{ id: string }>(
							`INSERT INTO announcement (title, body, severity, starts_at, ends_at) VALUES ('t', 'b', 'info', now() - interval '1 hour', now() + interval '1 hour') RETURNING id`,
						)
					).at(0)?.id ?? "";
				const { text, values } = build(ids.admin, { ...ctx(), org, announcement, token: `valid-${name}-${run}` });
				await expect(app.query(text, values), name).resolves.toBeTruthy();
			}
		});

		it("also guards the predicate: it says no for every non-admin and for a missing actor, and never raises", async () => {
			for (const actor of [
				ids.plain,
				ids.bannedAdmin,
				ids.adminNo2fa,
				ids.lookalike,
				ids.superadmin,
				ids.upper,
				ids.unknown,
				"",
			]) {
				const { rows } = await app.query(`SELECT careeros_is_platform_admin($1::text) AS ok`, [actor]);
				expect(rows[0].ok, actor).toBe(false);
			}
			expect((await app.query(`SELECT careeros_is_platform_admin(NULL::text) AS ok`)).rows[0].ok).toBe(false);
			expect((await app.query(`SELECT careeros_is_platform_admin($1::text) AS ok`, [ids.admin])).rows[0].ok).toBe(true);
		});

		it("does its work and its audit row in one transaction: a rollback takes both back, a commit keeps both", async () => {
			const org = await newOrg("Atomic", [[ids.ownerA, "owner"]]);
			const client = await app.connect();
			try {
				await client.query("BEGIN");
				await client.query(`SELECT careeros_admin_set_org_status($1, $2, 'suspended', 'security test: rollback')`, [
					ids.admin,
					org,
				]);
				await client.query("ROLLBACK");
				expect((await ownerRows(`SELECT status FROM organization WHERE id = $1`, [org]))[0]).toMatchObject({
					status: "active",
				});
				expect(
					await ownerRows(`SELECT 1 FROM audit_log WHERE organization_id = $1 AND action = 'admin.org_status_set'`, [
						org,
					]),
				).toHaveLength(0);

				await client.query("BEGIN");
				await client.query(`SELECT careeros_admin_set_org_status($1, $2, 'suspended', 'security test: commit')`, [
					ids.admin,
					org,
				]);
				await client.query("COMMIT");
				expect((await ownerRows(`SELECT status FROM organization WHERE id = $1`, [org]))[0]).toMatchObject({
					status: "suspended",
				});
				expect(
					await ownerRows(`SELECT 1 FROM audit_log WHERE organization_id = $1 AND action = 'admin.org_status_set'`, [
						org,
					]),
				).toHaveLength(1);
			} finally {
				client.release();
			}
		});
	});

	describe("every function writes the audit row for the call it did", () => {
		// The console's own row (`admin.*`) is exactly one per call, whoever the target. Functions that wrap an earlier
		// task's function (plan and status changes, manual payments, impersonation) add that function's rows as well, in
		// the organization's own trail: they are named here, so a change in what a call writes is a decision.
		const expected: Record<
			string,
			{ adminAction: string | null; others: string[]; organization: "target" | "platform" }
		> = {
			careeros_assert_platform_admin: { adminAction: null, others: [], organization: "platform" },
			careeros_admin_list_orgs: { adminAction: "admin.orgs_listed", others: [], organization: "platform" },
			careeros_admin_get_org: { adminAction: "admin.org_viewed", others: [], organization: "target" },
			careeros_admin_set_org_status: {
				adminAction: "admin.org_status_set",
				others: ["org.status_changed"],
				organization: "target",
			},
			careeros_admin_set_org_plan: {
				adminAction: "admin.org_plan_set",
				others: ["org.plan_changed", "subscription.updated"],
				organization: "target",
			},
			careeros_admin_set_ai_overage: {
				adminAction: "admin.ai_overage_set",
				others: ["subscription.updated"],
				organization: "target",
			},
			careeros_admin_record_manual_payment: { adminAction: null, others: [], organization: "target" },
			careeros_admin_metrics: { adminAction: "admin.metrics_viewed", others: [], organization: "platform" },
			careeros_admin_list_audit: { adminAction: "admin.audit_viewed", others: [], organization: "platform" },
			careeros_admin_announcement_save: {
				adminAction: "admin.announcement_saved",
				others: [],
				organization: "platform",
			},
			careeros_admin_announcement_list: {
				adminAction: "admin.announcements_listed",
				others: [],
				organization: "platform",
			},
			careeros_admin_announcement_end: {
				adminAction: "admin.announcement_ended",
				others: [],
				organization: "platform",
			},
			careeros_admin_impersonation_start: {
				adminAction: "admin.impersonation_started",
				others: ["impersonation.started"],
				organization: "platform",
			},
		};

		it("has an expectation for every function with an actor", () => {
			expect(Object.keys(expected).sort()).toEqual(Object.keys(calls).sort());
		});

		for (const [name, build] of Object.entries(calls)) {
			it(`${name}: who, what, where and when`, async () => {
				const org = await newOrg(`Audit ${name}`, [
					[ids.ownerA, "owner"],
					[ids.memberA, "member"],
				]);
				const announcement =
					(
						await ownerRows<{ id: string }>(
							`INSERT INTO announcement (title, body, severity, starts_at, ends_at) VALUES ('t', 'b', 'info', now() - interval '1 hour', now() + interval '1 hour') RETURNING id`,
						)
					).at(0)?.id ?? "";
				const started = await dbNow();
				const { text, values } = build(ids.admin, { ...ctx(), org, announcement, token: `audit-${name}-${run}` });
				await app.query(text, values);
				const finished = await dbNow();
				const rows = await auditSince(started);
				const spec = expected[name];
				if (!spec) throw new Error(`no expectation for ${name}`);

				if (name === "careeros_admin_record_manual_payment") {
					// T04's function writes the payment rows; the wrapper adds none of its own.
					expect(
						rows.some((row) => row.action === "billing.manual_payment" && row.organization_id === org),
						"a payment row",
					).toBe(true);
					expect(rows.filter((row) => row.action.startsWith("admin."))).toEqual([]);
					for (const row of rows) expect(row.actor_user_id, row.action).toBe(ids.admin);
					return;
				}

				const consoleRows = rows.filter((row) => row.action.startsWith("admin."));
				expect(
					consoleRows.map((row) => row.action),
					`${name} writes exactly one console row`,
				).toEqual(spec.adminAction ? [spec.adminAction] : []);
				expect(
					rows
						.filter((row) => !row.action.startsWith("admin."))
						.map((row) => row.action)
						.sort(),
					`${name} other rows`,
				).toEqual([...spec.others].sort());
				for (const row of rows) {
					expect(row.actor_user_id, `${row.action} names the admin`).toBe(ids.admin);
					expect(row.created_at >= started && row.created_at <= finished, `${row.action} is stamped by this call`).toBe(
						true,
					);
				}
				for (const row of consoleRows) {
					expect(row.organization_id, `${row.action} organization`).toBe(spec.organization === "target" ? org : null);
					expect(row.target_type, `${row.action} names what it acted on`).toBeTruthy();
				}
				// No personal data beyond ids and the typed reason, in any row.
				const text_ = JSON.stringify(rows.map((row) => row.metadata));
				expect(text_, "no email in an audit row").not.toContain("@example.test");
				expect(text_, "no name in an audit row").not.toContain("Name of");
			});
		}

		it("the two list functions write one row without detail", async () => {
			const started = await dbNow();
			await app.query(`SELECT * FROM careeros_admin_list_orgs($1, 'secret-search-term', NULL, NULL, 5, 0)`, [
				ids.admin,
			]);
			await app.query(`SELECT careeros_admin_metrics($1, NULL, NULL)`, [ids.admin]);
			const rows = await auditSince(started);
			expect(rows.map((row) => [row.action, row.metadata])).toEqual([
				["admin.orgs_listed", {}],
				["admin.metrics_viewed", {}],
			]);
		});

		it("records each action the console's spec names, with who, where and why", async () => {
			const org = await newOrg("Lifecycle", [
				[ids.ownerA, "owner"],
				[ids.memberA, "member"],
			]);
			const started = await dbNow();
			const as = (text: string, values: unknown[]) => app.query(text, values);
			await as(`SELECT careeros_admin_set_org_status($1, $2, 'suspended', 'security test: suspend')`, [ids.admin, org]);
			await as(`SELECT careeros_admin_set_org_status($1, $2, 'active', 'security test: unsuspend')`, [ids.admin, org]);
			await as(`SELECT careeros_admin_set_org_plan($1, $2, 'starter', 4, 'security test: plan')`, [ids.admin, org]);
			await as(
				`SELECT careeros_admin_record_manual_payment($1, $2, 'starter', 4, 'month', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', 4900, 'USD', $3)`,
				[ids.admin, org, `lifecycle-${run}`],
			);
			const hash = sha256(`lifecycle-${run}`);
			const start = (
				await as(
					`SELECT * FROM careeros_admin_impersonation_start($1, $2, $3, 'security test: support', 'https://acme.orgs.test', $4)`,
					[ids.admin, ids.memberA, org, hash],
				)
			).rows[0];
			await owner.query(`UPDATE impersonation SET session_id = 'sess-lifecycle', redeemed_at = now() WHERE id = $1`, [
				start.out_id,
			]);
			expect(
				(await as(`SELECT careeros_impersonation_end('sess-lifecycle', $1) AS ended`, [ids.memberA])).rows[0].ended,
			).toBe(true);
			const saved = (
				await as(
					`SELECT careeros_admin_announcement_save($1, NULL, 'Title', 'Body', 'warning', now() - interval '1 minute', now() + interval '1 hour', NULL, $2) AS id`,
					[ids.admin, org],
				)
			).rows[0].id;
			await as(`SELECT careeros_admin_announcement_end($1, $2)`, [ids.admin, saved]);

			const rows = (await auditSince(started)).filter((row) => row.action !== "subscription.updated");
			const by = (action: string) => rows.filter((row) => row.action === action);
			const status = by("admin.org_status_set");
			expect(
				status.map((row) => [
					row.organization_id,
					row.actor_user_id,
					row.target_id,
					row.metadata.to,
					row.metadata.reason,
				]),
			).toEqual([
				[org, ids.admin, org, "suspended", "security test: suspend"],
				[org, ids.admin, org, "active", "security test: unsuspend"],
			]);
			expect(
				by("admin.org_plan_set").map((row) => [row.organization_id, row.actor_user_id, row.metadata.reason]),
			).toEqual([[org, ids.admin, "security test: plan"]]);
			expect(by("billing.manual_payment").map((row) => [row.organization_id, row.actor_user_id])).toEqual([
				[org, ids.admin],
			]);
			for (const [action, organization] of [
				["impersonation.started", org],
				["admin.impersonation_started", null],
			] as const)
				expect(
					by(action).map((row) => [row.organization_id, row.actor_user_id, row.target_id]),
					action,
				).toEqual([[organization, ids.admin, ids.memberA]]);
			for (const [action, organization] of [
				["impersonation.ended", org],
				["admin.impersonation_ended", null],
			] as const)
				expect(
					by(action).map((row) => [row.organization_id, row.actor_user_id, row.metadata.endReason]),
					action,
				).toEqual([[organization, ids.admin, "ended"]]);
			expect(by("admin.announcement_saved").map((row) => row.actor_user_id)).toEqual([ids.admin]);
			expect(by("admin.announcement_ended").map((row) => row.actor_user_id)).toEqual([ids.admin]);
		});
	});

	describe("the functions without an actor cannot be used to reach anyone's data", () => {
		it("answer nothing and write nothing for forged ids, tokens and sessions", async () => {
			const before = await state();
			const fake = `forged-${run}`;
			expect(
				(
					await app.query(`SELECT * FROM careeros_impersonation_redeem($1, $2, 'https://acme.orgs.test', $3)`, [
						fake,
						sha256(fake),
						orgA,
					])
				).rows,
			).toEqual([]);
			expect(
				(await app.query(`SELECT careeros_impersonation_attach_session($1, $2, $3) AS ok`, [fake, "sess", ids.memberA]))
					.rows[0].ok,
			).toBe(false);
			expect(
				(await app.query(`SELECT careeros_impersonation_active($1, $2, $3) AS ok`, [fake, ids.memberA, ids.admin]))
					.rows[0].ok,
			).toBe(false);
			expect(
				(await app.query(`SELECT * FROM careeros_impersonation_for_session($1, $2)`, [fake, ids.memberA])).rows,
			).toEqual([]);
			expect((await app.query(`SELECT careeros_impersonation_end($1, $2) AS ok`, [fake, ids.memberA])).rows[0].ok).toBe(
				false,
			);
			expect((await app.query(`SELECT careeros_impersonation_expire_due() AS n`)).rows[0].n).toBe(0);
			expect(await state()).toEqual(before);
		});

		it("do not let one member touch another's support session or end a live one with the wrong user or session", async () => {
			const org = await newOrg("Sessions", [
				[ids.ownerA, "owner"],
				[ids.memberA, "member"],
			]);
			const start = (
				await app.query(
					`SELECT * FROM careeros_admin_impersonation_start($1, $2, $3, 'security test: support', 'https://acme.orgs.test', $4)`,
					[ids.admin, ids.memberA, org, sha256(`live-${run}`)],
				)
			).rows[0];
			await owner.query(`UPDATE impersonation SET session_id = 'sess-live', redeemed_at = now() WHERE id = $1`, [
				start.out_id,
			]);
			const before = await state();
			expect(
				(await app.query(`SELECT careeros_impersonation_end('sess-live', $1) AS ok`, [ids.ownerA])).rows[0].ok,
				"another user",
			).toBe(false);
			expect(
				(await app.query(`SELECT careeros_impersonation_end('sess-other', $1) AS ok`, [ids.memberA])).rows[0].ok,
				"another session",
			).toBe(false);
			expect(
				(await app.query(`SELECT careeros_impersonation_active('sess-live', $1, $2) AS ok`, [ids.ownerA, ids.admin]))
					.rows[0].ok,
			).toBe(false);
			expect(
				(await app.query(`SELECT careeros_impersonation_active('sess-live', $1, $2) AS ok`, [ids.memberA, ids.ownerA]))
					.rows[0].ok,
				"a different impersonator",
			).toBe(false);
			expect(
				(await app.query(`SELECT * FROM careeros_impersonation_for_session('sess-live', $1)`, [ids.ownerA])).rows,
			).toEqual([]);
			expect(await state()).toEqual(before);
			expect(
				(await app.query(`SELECT careeros_impersonation_active('sess-live', $1, $2) AS ok`, [ids.memberA, ids.admin]))
					.rows[0].ok,
			).toBe(true);
		});
	});

	describe("audit log", () => {
		const asOrg = async <T>(organizationId: string | null, fn: (client: PoolClient) => Promise<T>) => {
			const client = await app.connect();
			try {
				await client.query("BEGIN");
				if (organizationId) await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [organizationId]);
				return await fn(client);
			} finally {
				await client.query("ROLLBACK").catch(() => undefined);
				client.release();
			}
		};
		const attempt = async (organizationId: string | null, text: string, values: unknown[] = []) =>
			asOrg(organizationId, async (client) => {
				try {
					await client.query(text, values);
					return undefined;
				} catch (error) {
					return error as { code?: string; message: string };
				}
			});

		beforeAll(async () => {
			// Console actions on A and on B, so each organization's trail holds its own.
			for (const org of [orgA, orgB]) {
				await app.query(`SELECT careeros_admin_get_org($1, $2)`, [ids.admin, org]);
				await app.query(`SELECT careeros_admin_set_org_plan($1, $2, 'starter', 3, 'security test: plan')`, [
					ids.admin,
					org,
				]);
			}
			await app.query(`SELECT careeros_admin_set_org_status($1, $2, 'suspended', 'security test: only A')`, [
				ids.admin,
				orgA,
			]);
			await app.query(`SELECT careeros_admin_set_org_status($1, $2, 'active', 'security test: only A again')`, [
				ids.admin,
				orgA,
			]);
			await app.query(`SELECT * FROM careeros_admin_list_orgs($1, NULL, NULL, NULL, 5, 0)`, [ids.admin]);
		});

		it("is append-only for careeros_app: no UPDATE, DELETE or TRUNCATE privilege, and no policy that would allow one", async () => {
			const [privileges] = await ownerRows<Record<string, boolean>>(
				`SELECT has_table_privilege('careeros_app', 'audit_log', 'SELECT') AS can_select,
				        has_table_privilege('careeros_app', 'audit_log', 'INSERT') AS can_insert,
				        has_table_privilege('careeros_app', 'audit_log', 'UPDATE') AS can_update,
				        has_table_privilege('careeros_app', 'audit_log', 'DELETE') AS can_delete,
				        has_table_privilege('careeros_app', 'audit_log', 'TRUNCATE') AS can_truncate,
				        has_column_privilege('careeros_app', 'audit_log', 'action', 'UPDATE') AS can_update_column`,
			);
			expect(privileges).toEqual({
				can_select: true,
				can_insert: true,
				can_update: false,
				can_delete: false,
				can_truncate: false,
				can_update_column: false,
			});
			const policies = await ownerRows<{ policyname: string; cmd: string; roles: string[] }>(
				`SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies WHERE tablename = 'audit_log'`,
			);
			for (const policy of policies.filter((row) => ["UPDATE", "DELETE", "ALL"].includes(row.cmd)))
				expect(policy.roles, `${policy.policyname} (${policy.cmd}) reaches only the owner`).not.toEqual(
					expect.arrayContaining(["public"]),
				);
			for (const policy of policies.filter((row) => ["UPDATE", "DELETE", "ALL"].includes(row.cmd)))
				expect(policy.roles, `${policy.policyname} (${policy.cmd}) does not reach the app role`).not.toContain(
					"careeros_app",
				);
		});

		it("refuses UPDATE, DELETE and TRUNCATE for careeros_app, with or without an organization in scope, and the rows stay", async () => {
			const before = await ownerRows(`SELECT id, action, metadata, actor_user_id FROM audit_log ORDER BY id`);
			for (const scope of [orgA, orgB, null]) {
				for (const text of [
					`UPDATE audit_log SET action = 'forged.action'`,
					`UPDATE audit_log SET actor_user_id = NULL`,
					`UPDATE audit_log SET metadata = '{}'::jsonb`,
					`DELETE FROM audit_log`,
					`DELETE FROM audit_log WHERE action LIKE 'admin.%'`,
					`TRUNCATE audit_log`,
				]) {
					const error = await attempt(scope, text);
					expect(error?.code, `${text} (scope ${scope ?? "none"})`).toBe("42501");
				}
			}
			expect(await ownerRows(`SELECT id, action, metadata, actor_user_id FROM audit_log ORDER BY id`)).toEqual(before);
		});

		it("does not let careeros_app write an audit row for another organization or for the platform", async () => {
			const insert = `INSERT INTO audit_log (organization_id, actor_user_id, action) VALUES ($1, $2, 'admin.org_status_set')`;
			expect((await attempt(orgA, insert, [orgB, ids.admin]))?.code, "another organization").toBe("42501");
			expect((await attempt(orgA, insert, [null, ids.admin]))?.code, "the platform").toBe("42501");
			expect((await attempt(null, insert, [orgA, ids.admin]))?.code, "no organization in scope").toBe("42501");
			// Its own organization's row is allowed (the app records member-level events itself).
			expect(await attempt(orgA, insert, [orgA, ids.ownerA])).toBeUndefined();
		});

		it("shows an organization its own entries only, and never another organization's or the platform's", async () => {
			const view = async (organizationId: string | null) =>
				asOrg(
					organizationId,
					async (client) =>
						(
							await client.query<{ organization_id: string | null; action: string; metadata: unknown }>(
								`SELECT organization_id, action, metadata FROM audit_log`,
							)
						).rows,
				);
			const a = await view(orgA);
			const b = await view(orgB);
			expect(a.length).toBeGreaterThan(3);
			expect(b.length).toBeGreaterThan(1);
			expect(new Set(a.map((row) => row.organization_id))).toEqual(new Set([orgA]));
			expect(new Set(b.map((row) => row.organization_id))).toEqual(new Set([orgB]));
			expect(await view(null), "no organization in scope sees nothing").toEqual([]);
			// The platform rows exist (the lists above) and are invisible to both.
			expect(
				(await ownerRows(`SELECT 1 FROM audit_log WHERE organization_id IS NULL AND action LIKE 'admin.%'`)).length,
			).toBeGreaterThan(0);
			expect(a.some((row) => row.organization_id === null) || b.some((row) => row.organization_id === null)).toBe(
				false,
			);
		});

		it("never shows what the console did to organization A in organization B's view", async () => {
			const bView = await asOrg(orgB, async (client) => (await client.query(`SELECT * FROM audit_log`)).rows);
			const text = JSON.stringify(bView);
			expect(text, "B's view never names A").not.toContain(orgA);
			expect(text).not.toContain("only A");
			expect(bView.filter((row) => row.action === "admin.org_status_set")).toEqual([]);
			// The same console calls on B are in B's own view.
			expect(bView.some((row) => row.action === "admin.org_plan_set")).toBe(true);
			const aView = await asOrg(orgA, async (client) => (await client.query(`SELECT * FROM audit_log`)).rows);
			expect(JSON.stringify(aView)).not.toContain(orgB);
			expect(aView.filter((row) => row.action === "admin.org_status_set")).toHaveLength(2);
		});

		it("is read by a platform admin only through the definer function, which sees every organization and audits the read", async () => {
			const started = await dbNow();
			const { rows } = await app.query<{ organization_id: string | null }>(
				`SELECT * FROM careeros_admin_list_audit($1, NULL, false, NULL, NULL, NULL, NULL, 200)`,
				[ids.admin],
			);
			const seen = new Set(rows.map((row) => row.organization_id));
			expect(seen.has(orgA) && seen.has(orgB) && seen.has(null)).toBe(true);
			expect((await auditSince(started)).map((row) => row.action)).toEqual(["admin.audit_viewed"]);
			await expect(
				app.query(`SELECT * FROM careeros_admin_list_audit($1, NULL, false, NULL, NULL, NULL, NULL, 200)`, [
					ids.ownerA,
				]),
			).rejects.toMatchObject({ code: "42501" });
		});
	});
});
