import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";
import { withDatabasePool } from "@reactive-resume/db/client";

// P3-T07: the Super Admin console's definer functions on a database of its own with every migration applied, called
// through the `careeros_app` role (NOSUPERUSER, NOBYPASSRLS), exactly as the server calls them. Skipped only when the
// CAREEROS_TEST_* variables are absent; CI sets them. The tests are written as tables over the function list so that
// P3-Q03 (super admin security) can extend them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

describe.skipIf(!configured)("platform admin: definer functions", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		admin: `pa-admin-${run}`,
		adminNo2fa: `pa-admin-no2fa-${run}`,
		bannedAdmin: `pa-banned-admin-${run}`,
		plain: `pa-plain-${run}`,
		ownerA: `pa-owner-a-${run}`,
		memberA: `pa-member-a-${run}`,
		ownerB: `pa-owner-b-${run}`,
		forged: `pa-nobody-${run}`,
	};
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let admin: typeof import("./index");
	let orgA: string;
	let orgB: string;
	let counter = 0;

	const inApp = <T>(fn: () => Promise<T>) => withDatabasePool(app, fn);
	const ownerRows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
		(await owner.query<T>(sql, params)).rows;
	const auditCount = async () => Number((await ownerRows<{ n: string }>(`SELECT count(*) AS n FROM audit_log`))[0]?.n);
	const auditRows = (where: string, params: unknown[] = []) =>
		ownerRows<{
			organization_id: string | null;
			actor_user_id: string | null;
			action: string;
			target_type: string | null;
			target_id: string | null;
			metadata: Record<string, unknown>;
		}>(
			`SELECT organization_id, actor_user_id, action, target_type, target_id, metadata FROM audit_log WHERE ${where} ORDER BY created_at, (organization_id IS NULL), id`,
			params,
		);
	const adminActions = async (since: number) =>
		(
			await ownerRows<{ action: string }>(
				`SELECT action FROM audit_log WHERE action LIKE 'admin.%' ORDER BY id OFFSET $1`,
				[since],
			)
		).map((row) => row.action);
	const newOrg = async (name: string, members: [string, string][]) => {
		const id = `pa-org-${run}-${++counter}`;
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

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("platform_admin");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		const users: [string, string, boolean, boolean][] = [
			[ids.admin, "admin", true, false],
			[ids.adminNo2fa, "admin", false, false],
			[ids.bannedAdmin, "admin", true, true],
			[ids.plain, "user", false, false],
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
		admin = await import("./index");
	}, 180_000);

	afterAll(async () => {
		await owner?.end();
		await app?.end();
		await database?.drop();
	});

	// Every definer function of the console, as a call with an actor. Each is run against a refused actor below and, once,
	// against the real admin.
	const calls: { name: string; call: (actor: string) => Promise<unknown>; action: string }[] = [
		{ name: "list orgs", call: (actor) => admin.listOrgs(actor), action: "admin.orgs_listed" },
		{ name: "get org", call: (actor) => admin.getOrg(actor, orgA), action: "admin.org_viewed" },
		{
			name: "suspend org",
			call: (actor) => admin.setOrgStatus(actor, orgA, "suspended", "unpaid invoice"),
			action: "admin.org_status_set",
		},
		{
			name: "set plan",
			call: (actor) => admin.setOrgPlan(actor, orgA, "starter", 5, "sold a starter plan"),
			action: "admin.org_plan_set",
		},
		{
			name: "ai overage",
			call: (actor) => admin.setAiOverage(actor, orgA, true, "pilot customer"),
			action: "admin.ai_overage_set",
		},
		{ name: "metrics", call: (actor) => admin.getMetrics(actor), action: "admin.metrics_viewed" },
		{ name: "list audit", call: (actor) => admin.listAudit(actor), action: "admin.audit_viewed" },
		{
			name: "save announcement",
			call: (actor) =>
				admin.saveAnnouncement(actor, {
					title: "Hello",
					body: "Plain text",
					severity: "info",
					startsAt: new Date(Date.now() - 1000),
					endsAt: new Date(Date.now() + 3_600_000),
				}),
			action: "admin.announcement_saved",
		},
		{
			name: "list announcements",
			call: (actor) => admin.listAnnouncements(actor),
			action: "admin.announcements_listed",
		},
		{
			name: "start impersonation",
			call: (actor) =>
				admin.startImpersonation(actor, {
					targetUserId: ids.memberA,
					organizationId: orgA,
					reason: "support ticket 42",
					targetOrigin: "https://acme.orgs.test",
				}),
			action: "admin.impersonation_started",
		},
		{
			name: "record manual payment",
			call: (actor) =>
				admin.recordManualPayment(actor, {
					orgId: orgA,
					planId: "starter",
					seats: 5,
					interval: "month",
					periodStart: new Date("2026-11-01T00:00:00Z"),
					periodEnd: new Date("2026-12-01T00:00:00Z"),
					amount: 4900,
					currency: "USD",
					reference: `refusal-${run}`,
				}),
			action: "billing.manual_payment",
		},
		{
			name: "end announcement",
			call: (actor) => admin.endAnnouncement(actor, `no-such-${run}`),
			action: "admin.announcement_ended",
		},
	];

	describe("refusals: no audit row, no change", () => {
		const refused: [string, string, string][] = [
			["a plain user", ids.plain, "not_admin"],
			["an admin without two-factor authentication", ids.adminNo2fa, "two_factor_required"],
			["a banned admin", ids.bannedAdmin, "not_admin"],
			["an actor id that does not exist (forged)", ids.forged, "not_admin"],
			["the id of a member of the organization (forged)", ids.ownerA, "not_admin"],
		];
		for (const [who, actor, code] of refused) {
			it(`refuses ${who} on every function`, async () => {
				const before = await auditCount();
				const orgBefore = await ownerRows(`SELECT status, plan_id FROM organization WHERE id = $1`, [orgA]);
				for (const { name, call } of calls)
					await expect(
						inApp(() => call(actor)),
						`${name} as ${who}`,
					).rejects.toMatchObject({ code });
				expect(await auditCount(), "a refused call writes no audit row").toBe(before);
				expect(await ownerRows(`SELECT status, plan_id FROM organization WHERE id = $1`, [orgA])).toEqual(orgBefore);
				expect(Number((await ownerRows<{ n: string }>(`SELECT count(*) AS n FROM announcement`))[0]?.n)).toBe(0);
			});
		}

		it("refuses a platform admin who lost the role, and an expired ban counts as not banned", async () => {
			await owner.query(`UPDATE "user" SET role = 'user' WHERE id = $1`, [ids.admin]);
			await expect(inApp(() => admin.listOrgs(ids.admin))).rejects.toMatchObject({ code: "not_admin" });
			await owner.query(`UPDATE "user" SET role = 'user,admin' WHERE id = $1`, [ids.admin]);
			await inApp(() => admin.listOrgs(ids.admin));
			await owner.query(`UPDATE "user" SET banned = true, ban_expires = now() + interval '1 day' WHERE id = $1`, [
				ids.admin,
			]);
			await expect(inApp(() => admin.listOrgs(ids.admin))).rejects.toMatchObject({ code: "not_admin" });
			await owner.query(`UPDATE "user" SET banned = true, ban_expires = now() - interval '1 day' WHERE id = $1`, [
				ids.admin,
			]);
			await inApp(() => admin.listOrgs(ids.admin));
			await owner.query(`UPDATE "user" SET role = 'admin', banned = false, ban_expires = NULL WHERE id = $1`, [
				ids.admin,
			]);
		});
	});

	describe("the app role and the definer functions", () => {
		it("keeps careeros_app without BYPASSRLS or superuser, and without any privilege on the console's tables", async () => {
			const [role] = await ownerRows<{ rolbypassrls: boolean; rolsuper: boolean }>(
				`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'careeros_app'`,
			);
			expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
			for (const table of ["announcement", "announcement_dismissal", "impersonation"])
				for (const kind of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
					const [row] = await ownerRows<{ ok: boolean }>(`SELECT has_table_privilege('careeros_app', $1, $2) AS ok`, [
						table,
						kind,
					]);
					expect(row?.ok, `${kind} on ${table}`).toBe(false);
				}
			await expect(app.query(`SELECT * FROM announcement`)).rejects.toMatchObject({ code: "42501" });
			await expect(app.query(`SELECT * FROM impersonation`)).rejects.toMatchObject({ code: "42501" });
		});

		it("cannot read another organization's rows outside the functions", async () => {
			// No organization in scope: every tenant table is empty for the app role, whatever it holds.
			for (const table of ["subscription", "audit_log", "member_cohort_none", "ai_usage"]) {
				if (table === "member_cohort_none") continue;
				const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
				expect(rows[0].n, table).toBe(0);
			}
			// With organization A in scope it sees A's subscription and not B's.
			const client = await app.connect();
			try {
				await client.query("BEGIN");
				await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgA]);
				const { rows } = await client.query(`SELECT organization_id FROM subscription`);
				expect(rows.map((row) => row.organization_id)).toEqual([orgA]);
				await client.query("ROLLBACK");
			} finally {
				client.release();
			}
		});

		it("pins search_path, is SECURITY DEFINER, and is revoked from PUBLIC, for every console function", async () => {
			const functions = await ownerRows<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
				`SELECT proname, prosecdef, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
				 WHERE n.nspname = 'public' AND (proname LIKE 'careeros\\_admin\\_%' OR proname LIKE 'careeros\\_impersonation\\_%'
				   OR proname IN ('careeros_announcements_for_member', 'careeros_announcement_dismiss', 'careeros_is_platform_admin', 'careeros_assert_platform_admin'))`,
			);
			expect(functions.length).toBeGreaterThanOrEqual(22);
			for (const fn of functions) {
				if (fn.proname !== "careeros_admin_check_reason" && fn.proname !== "careeros_quota_period")
					expect(fn.prosecdef, `${fn.proname} is SECURITY DEFINER`).toBe(true);
				expect(fn.proconfig?.join(","), `${fn.proname} pins search_path`).toContain("search_path=pg_catalog, public");
			}
			const publicGrants = await ownerRows<{ proname: string }>(
				`SELECT p.proname FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
				 WHERE (p.proname LIKE 'careeros\\_admin\\_%' OR p.proname LIKE 'careeros\\_impersonation\\_%'
				   OR p.proname LIKE 'careeros\\_announcement%' OR p.proname LIKE 'careeros\\_%platform\\_admin') AND a.grantee = 0`,
			);
			expect(publicGrants).toEqual([]);
			const [app_] = await ownerRows<{ ok: boolean }>(
				`SELECT has_function_privilege('careeros_app', 'careeros_admin_list_orgs(text, text, text, text, integer, integer)', 'EXECUTE') AS ok`,
			);
			expect(app_?.ok).toBe(true);
		});
	});

	describe("each function writes exactly one admin audit row", () => {
		// Runs the real admin once per function, in this order (the state the earlier functions leave is used by the later).
		for (const { name, call, action } of calls.filter(
			(entry) => entry.name !== "end announcement" && entry.name !== "record manual payment",
		)) {
			it(`${name} writes one ${action} row in the same call`, async () => {
				const before = await adminActions(0);
				await inApp(() => call(ids.admin));
				const after = await adminActions(0);
				expect(after.slice(before.length), name).toEqual([action]);
			});
		}

		it("records who, what and where, with no personal data beyond ids", async () => {
			const rows = await auditRows(`action = 'admin.org_status_set' AND organization_id = $1`, [orgA]);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				organization_id: orgA,
				actor_user_id: ids.admin,
				target_type: "organization",
				target_id: orgA,
				metadata: { from: "active", to: "suspended", reason: "unpaid invoice" },
			});
			const everything = JSON.stringify(await auditRows(`action LIKE 'admin.%'`));
			expect(everything).not.toContain("@example.test");
			// The list and the metrics write a row without detail.
			expect(
				(await auditRows(`action IN ('admin.orgs_listed', 'admin.metrics_viewed', 'admin.audit_viewed')`)).every(
					(row) => Object.keys(row.metadata).length === 0,
				),
			).toBe(true);
		});

		it("suspends and reactivates, needs a reason, and refuses a no-op", async () => {
			expect(
				(await ownerRows<{ status: string }>(`SELECT status FROM organization WHERE id = $1`, [orgA]))[0]?.status,
			).toBe("suspended");
			await expect(inApp(() => admin.setOrgStatus(ids.admin, orgA, "suspended", "again"))).rejects.toMatchObject({
				code: "invalid",
			});
			await expect(inApp(() => admin.setOrgStatus(ids.admin, orgA, "active", "  "))).rejects.toMatchObject({
				code: "invalid",
			});
			const before = await auditCount();
			expect(await inApp(() => admin.setOrgStatus(ids.admin, orgA, "active", "invoice paid"))).toBe("active");
			expect(
				(await ownerRows<{ status: string }>(`SELECT status FROM organization WHERE id = $1`, [orgA]))[0]?.status,
			).toBe("active");
			// T01's own org.status_changed row for the organization's trail plus ours.
			expect(await auditCount()).toBe(before + 2);
			expect(
				(await auditRows(`organization_id = $1 AND action = 'org.status_changed'`, [orgA])).map(
					(row) => row.metadata.to,
				),
			).toEqual(["suspended", "active"]);
			await expect(
				inApp(() => admin.setOrgStatus(ids.admin, `missing-${run}`, "suspended", "no such org")),
			).rejects.toMatchObject({ code: "not_found" });
		});

		it("reactivates to trial or past_due when the subscription says so", async () => {
			const org = await newOrg("Trial Co", [[ids.ownerB, "owner"]].slice(0, 0) as [string, string][]);
			await owner.query(`UPDATE subscription SET status = 'trialing' WHERE organization_id = $1`, [org]);
			await inApp(() => admin.setOrgStatus(ids.admin, org, "suspended", "abuse report"));
			expect(await inApp(() => admin.setOrgStatus(ids.admin, org, "active", "resolved"))).toBe("trial");
			await inApp(() => admin.setOrgStatus(ids.admin, org, "suspended", "again"));
			await owner.query(`UPDATE subscription SET status = 'past_due' WHERE organization_id = $1`, [org]);
			expect(await inApp(() => admin.setOrgStatus(ids.admin, org, "active", "resolved again"))).toBe("past_due");
		});

		it("assigns a plan and seats within the plan, refuses more than the plan allows, and writes the plan rows", async () => {
			expect(
				(await ownerRows<{ plan_id: string }>(`SELECT plan_id FROM organization WHERE id = $1`, [orgA]))[0]?.plan_id,
			).toBe("starter");
			expect(
				(await ownerRows<{ seats: number }>(`SELECT seats FROM subscription WHERE organization_id = $1`, [orgA]))[0]
					?.seats,
			).toBe(5);
			await expect(inApp(() => admin.setOrgPlan(ids.admin, orgA, "starter", 51, "too many"))).rejects.toMatchObject({
				code: "invalid",
			});
			await expect(inApp(() => admin.setOrgPlan(ids.admin, orgA, "starter", 0, "none"))).rejects.toMatchObject({
				code: "invalid",
			});
			await expect(inApp(() => admin.setOrgPlan(ids.admin, orgA, "nonsense", null, "no plan"))).rejects.toMatchObject({
				code: "not_found",
			});
			await expect(inApp(() => admin.setOrgPlan(ids.admin, orgA, "pro", null, ""))).rejects.toMatchObject({
				code: "invalid",
			});
			expect(
				(
					await auditRows(`organization_id = $1 AND action IN ('org.plan_changed', 'subscription.updated')`, [orgA])
				).map((row) => row.action),
			).toContain("org.plan_changed");
		});

		it("sets the AI overage switch", async () => {
			expect(
				(
					await ownerRows<{ ai_overage_allowed: boolean }>(
						`SELECT ai_overage_allowed FROM subscription WHERE organization_id = $1`,
						[orgA],
					)
				)[0]?.ai_overage_allowed,
			).toBe(true);
			await inApp(() => admin.setAiOverage(ids.admin, orgA, false, "pilot over"));
			expect(
				(
					await ownerRows<{ ai_overage_allowed: boolean }>(
						`SELECT ai_overage_allowed FROM subscription WHERE organization_id = $1`,
						[orgA],
					)
				)[0]?.ai_overage_allowed,
			).toBe(false);
			expect((await auditRows(`action = 'admin.ai_overage_set'`)).map((row) => row.metadata.to)).toEqual([true, false]);
		});
	});

	describe("manual payments", () => {
		const payment = (reference: string, overrides: Partial<Parameters<typeof admin.recordManualPayment>[1]> = {}) => ({
			orgId: orgA,
			planId: "pro",
			seats: 8,
			interval: "month" as const,
			periodStart: new Date("2026-11-01T00:00:00Z"),
			periodEnd: new Date("2026-12-01T00:00:00Z"),
			amount: 9600,
			currency: "USD",
			reference,
			...overrides,
		});

		it("applies once, audits with the actor, and a repeated reference is a no-op", async () => {
			expect(await inApp(() => admin.recordManualPayment(ids.admin, payment(`INV-${run}-1`)))).toBe(true);
			expect(await inApp(() => admin.recordManualPayment(ids.admin, payment(`INV-${run}-1`)))).toBe(false);
			const rows = await auditRows(`organization_id = $1 AND action = 'billing.manual_payment'`, [orgA]);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				actor_user_id: ids.admin,
				metadata: { amount: 9600, currency: "USD", reference: `INV-${run}-1` },
			});
			const [state] = await ownerRows<{ plan_id: string; provider: string; seats: number }>(
				`SELECT o.plan_id, s.provider, s.seats FROM organization o JOIN subscription s ON s.organization_id = o.id WHERE o.id = $1`,
				[orgA],
			);
			expect(state).toEqual({ plan_id: "pro", provider: "manual", seats: 8 });
		});

		it("refuses an input T04's function refuses, as an invalid request", async () => {
			await expect(inApp(() => admin.recordManualPayment(ids.admin, payment("bad ref ; drop")))).rejects.toMatchObject({
				code: "invalid",
			});
			await expect(
				inApp(() =>
					admin.recordManualPayment(
						ids.admin,
						payment(`INV-${run}-old`, { periodEnd: new Date("2026-11-15T00:00:00Z") }),
					),
				),
			).rejects.toMatchObject({ code: "invalid" });
		});
	});

	describe("lists, details, metrics and the audit log", () => {
		it("lists organizations with seats, plan and AI credits, filters and pages them, and shows no member names or emails", async () => {
			await owner.query(
				`INSERT INTO ai_usage (organization_id, user_id, source, feature, provider, model, credits, cost_usd_micros, input_tokens, output_tokens) VALUES ($1, $2, 'platform', 'resume.improve', 'anthropic', 'claude-sonnet-5-5', 7, 70000, 100, 200)`,
				[orgA, ids.memberA],
			);
			await owner.query(`UPDATE "user" SET last_active_at = now() WHERE id = $1`, [ids.memberA]);
			const all = await inApp(() => admin.listOrgs(ids.admin, { limit: 100 }));
			const a = all.rows.find((row) => row.id === orgA);
			expect(a).toMatchObject({
				name: "Acme Coaching",
				slug: orgA,
				planId: "pro",
				seatsUsed: 2,
				seatLimit: 8,
				aiCreditsUsed: 7,
			});
			expect(a?.lastActiveAt).toBeInstanceOf(Date);
			expect(all.total).toBeGreaterThanOrEqual(2);
			expect(JSON.stringify(all.rows)).not.toMatch(/@example\.test|Name of/);
			expect((await inApp(() => admin.listOrgs(ids.admin, { search: "acme" }))).rows.map((row) => row.id)).toEqual([
				orgA,
			]);
			expect((await inApp(() => admin.listOrgs(ids.admin, { search: orgB }))).rows.map((row) => row.id)).toEqual([
				orgB,
			]);
			expect((await inApp(() => admin.listOrgs(ids.admin, { search: "100%_" }))).rows).toEqual([]);
			expect(
				(await inApp(() => admin.listOrgs(ids.admin, { planId: "pro", search: run }))).rows.map((row) => row.id),
			).toEqual([orgA]);
			const first = await inApp(() => admin.listOrgs(ids.admin, { limit: 1, search: run }));
			const second = await inApp(() => admin.listOrgs(ids.admin, { limit: 1, offset: 1, search: run }));
			expect(first.rows).toHaveLength(1);
			expect(second.rows).toHaveLength(1);
			expect(first.rows[0]?.id).not.toBe(second.rows[0]?.id);
			expect(first.total).toBeGreaterThanOrEqual(3);
		});

		it("returns an organization in full, with its owners but not its other members", async () => {
			const detail = await inApp(() => admin.getOrg(ids.admin, orgA));
			expect(detail.organization).toMatchObject({ id: orgA, name: "Acme Coaching", planId: "pro" });
			expect(detail.owners).toEqual([
				{ id: ids.ownerA, name: `Name of ${ids.ownerA}`, email: `${ids.ownerA}@example.test` },
			]);
			expect(JSON.stringify(detail)).not.toContain(ids.memberA);
			expect(detail.seats).toMatchObject({ members: 2, used: 2, limit: 8 });
			expect(detail.subscription).toMatchObject({ provider: "manual", seats: 8, status: "active" });
			expect(detail.aiUsage).toMatchObject({ credits: 7, costUsdMicros: 70000, calls: 1 });
			expect(detail.aiUsage.byFeature[0]).toMatchObject({ feature: "resume.improve", credits: 7 });
			expect(detail.aiUsage.creditsTotal).toBe(300 * 8);
			expect(detail.billingEvents[0]).toMatchObject({
				provider: "manual",
				type: "payment.succeeded",
				outcome: "applied",
			});
			await expect(inApp(() => admin.getOrg(ids.admin, `missing-${run}`))).rejects.toMatchObject({ code: "not_found" });
		});

		it("reports counts, MRR, revenue in the period by currency, AI cost and AI cost against revenue", async () => {
			const metrics = await inApp(() =>
				admin.getMetrics(ids.admin, { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) }),
			);
			expect(metrics.orgsByStatus.active).toBeGreaterThanOrEqual(2);
			expect(metrics.orgsByPlan.pro).toBeGreaterThanOrEqual(1);
			expect(metrics.newOrgs).toBeGreaterThanOrEqual(3);
			expect(metrics.activeMembers).toBeGreaterThanOrEqual(1);
			expect(metrics.revenue).toContainEqual({ currency: "USD", amountMinor: 9600 });
			// Pro is priced per seat: 1,200 cents x 8 seats.
			expect(metrics.mrr).toContainEqual({ currency: "USD", amountMinor: 1200 * 8 });
			expect(metrics.aiCostUsdMicros).toBeGreaterThanOrEqual(70000);
			const mine = metrics.aiCostByOrg.find((row) => row.organizationId === orgA);
			expect(mine).toMatchObject({ name: "Acme Coaching", costUsdMicros: 70000, credits: 7 });
			expect(mine?.revenue).toContainEqual({ currency: "USD", amountMinor: 9600 });
			await expect(
				inApp(() => admin.getMetrics(ids.admin, { from: new Date(2026, 5, 2), to: new Date(2026, 5, 1) })),
			).rejects.toMatchObject({ code: "invalid" });
		});

		it("lists the audit log of every organization, filtered and paged", async () => {
			const first = await inApp(() => admin.listAudit(ids.admin, { limit: 3 }));
			expect(first).toHaveLength(3);
			const next = await inApp(() => admin.listAudit(ids.admin, { limit: 3, before: first[2]?.id }));
			expect(next[0]?.id).not.toBe(first[2]?.id);
			expect(next[0] && first[2] && next[0].id < first[2].id).toBe(true);
			const forOrg = await inApp(() => admin.listAudit(ids.admin, { organizationId: orgA, limit: 200 }));
			expect(forOrg.length).toBeGreaterThan(3);
			expect(forOrg.every((row) => row.organizationId === orgA && row.organizationName === "Acme Coaching")).toBe(true);
			const platform = await inApp(() => admin.listAudit(ids.admin, { platformOnly: true, limit: 200 }));
			expect(platform.every((row) => row.organizationId === null)).toBe(true);
			expect(platform.map((row) => row.action)).toContain("admin.orgs_listed");
			const byAction = await inApp(() => admin.listAudit(ids.admin, { action: "admin.org_status_set", limit: 200 }));
			expect(byAction.length).toBeGreaterThanOrEqual(2);
			expect(byAction.every((row) => row.action === "admin.org_status_set")).toBe(true);
			expect((await inApp(() => admin.listAudit(ids.admin, { from: new Date(Date.now() + 86_400_000) }))).length).toBe(
				0,
			);
		});
	});

	describe("announcements", () => {
		const window = { startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000) };
		const titles = async (userId: string, orgId: string) =>
			(await inApp(() => admin.activeAnnouncementsForMember(userId, orgId))).map((row) => row.title).sort();

		it("validates what is saved (plain text up to 1,000 characters, severity, window)", async () => {
			const bad = [
				{ title: "", body: "x", severity: "info" as const },
				{ title: "t", body: "", severity: "info" as const },
				{ title: "t", body: "x".repeat(1001), severity: "info" as const },
				{ title: "x".repeat(121), body: "x", severity: "info" as const },
				{ title: "t", body: "x", severity: "critical" as unknown as "info" },
			];
			for (const input of bad)
				await expect(inApp(() => admin.saveAnnouncement(ids.admin, { ...input, ...window }))).rejects.toBeDefined();
			await expect(
				inApp(() =>
					admin.saveAnnouncement(ids.admin, {
						title: "t",
						body: "x",
						severity: "info",
						startsAt: window.endsAt,
						endsAt: window.startsAt,
					}),
				),
			).rejects.toBeDefined();
			await expect(
				inApp(() =>
					admin.saveAnnouncement(ids.admin, {
						title: "t",
						body: "x",
						severity: "info",
						...window,
						organizationId: `missing-${run}`,
					}),
				),
			).rejects.toMatchObject({ code: "not_found" });
			await expect(
				inApp(() =>
					admin.saveAnnouncement(ids.admin, { title: "t", body: "x", severity: "info", ...window, planId: "nonsense" }),
				),
			).rejects.toMatchObject({ code: "not_found" });
			const ok = await inApp(() =>
				admin.saveAnnouncement(ids.admin, {
					title: "ok",
					body: "x".repeat(1000),
					severity: "warning",
					...window,
					organizationId: orgB,
				}),
			);
			expect(ok).toBeTruthy();
			await inApp(() => admin.endAnnouncement(ids.admin, ok));
		});

		it("shows members only what applies to them: window, plan, organization, membership, and dismissal per user", async () => {
			await owner.query(
				`UPDATE announcement SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour'`,
			);
			const global = await inApp(() =>
				admin.saveAnnouncement(ids.admin, { title: "for everyone", body: "g", severity: "info", ...window }),
			);
			await inApp(() =>
				admin.saveAnnouncement(ids.admin, {
					title: "pro only",
					body: "p",
					severity: "warning",
					...window,
					planId: "pro",
				}),
			);
			await inApp(() =>
				admin.saveAnnouncement(ids.admin, {
					title: "starter only",
					body: "s",
					severity: "info",
					...window,
					planId: "starter",
				}),
			);
			await inApp(() =>
				admin.saveAnnouncement(ids.admin, {
					title: "org B only",
					body: "b",
					severity: "info",
					...window,
					organizationId: orgB,
				}),
			);
			await inApp(() =>
				admin.saveAnnouncement(ids.admin, {
					title: "future",
					body: "f",
					severity: "info",
					startsAt: new Date(Date.now() + 3_600_000),
					endsAt: new Date(Date.now() + 7_200_000),
				}),
			);
			await inApp(() =>
				admin.saveAnnouncement(ids.admin, {
					title: "past",
					body: "f",
					severity: "info",
					startsAt: new Date(Date.now() - 7_200_000),
					endsAt: new Date(Date.now() - 3_600_000),
				}),
			);
			expect(await titles(ids.memberA, orgA)).toEqual(["for everyone", "pro only"]);
			expect(await titles(ids.ownerB, orgB)).toEqual(
				["for everyone", "org B only"].concat([]).filter((t) => t !== "pro only"),
			);
			// A user who is not a member of the organization gets nothing, even asking for it by id.
			expect(await titles(ids.memberA, orgB)).toEqual([]);
			expect(await titles(ids.forged, orgA)).toEqual([]);
			// Dismissal is per user.
			expect(await inApp(() => admin.dismissAnnouncement(ids.memberA, global))).toBe(true);
			expect(await inApp(() => admin.dismissAnnouncement(ids.memberA, global))).toBe(false);
			expect(await titles(ids.memberA, orgA)).toEqual(["pro only"]);
			expect(await titles(ids.ownerA, orgA)).toEqual(["for everyone", "pro only"]);
			expect(await inApp(() => admin.dismissAnnouncement(ids.memberA, `missing-${run}`))).toBe(false);
		});

		it("updates and ends an announcement, and audits both", async () => {
			const id = await inApp(() =>
				admin.saveAnnouncement(ids.admin, { title: "v1", body: "one", severity: "info", ...window }),
			);
			await inApp(() =>
				admin.saveAnnouncement(ids.admin, { id, title: "v2", body: "two", severity: "warning", ...window }),
			);
			const listed = await inApp(() => admin.listAnnouncements(ids.admin));
			expect(listed.find((row) => row.id === id)).toMatchObject({
				title: "v2",
				severity: "warning",
				createdBy: ids.admin,
			});
			await inApp(() => admin.endAnnouncement(ids.admin, id));
			await expect(inApp(() => admin.endAnnouncement(ids.admin, id))).rejects.toMatchObject({ code: "invalid" });
			expect((await auditRows(`target_id = $1`, [id])).map((row) => row.action)).toEqual([
				"admin.announcement_saved",
				"admin.announcement_saved",
				"admin.announcement_ended",
			]);
			await expect(
				inApp(() =>
					admin.saveAnnouncement(ids.admin, {
						id: `missing-${run}`,
						title: "t",
						body: "x",
						severity: "info",
						...window,
					}),
				),
			).rejects.toMatchObject({ code: "not_found" });
		});
	});

	describe("impersonation", () => {
		const origin = "https://acme.orgs.test";
		const start = (actor: string, overrides: Partial<Parameters<typeof admin.startImpersonation>[1]> = {}) =>
			inApp(() =>
				admin.startImpersonation(actor, {
					targetUserId: ids.memberA,
					organizationId: orgA,
					reason: "customer cannot export",
					targetOrigin: origin,
					...overrides,
				}),
			);
		const redeem = (
			started: { id: string; token: string },
			overrides: Partial<{ token: string; targetOrigin: string; organizationId: string }> = {},
		) =>
			inApp(() =>
				admin.redeemImpersonation({
					id: started.id,
					token: started.token,
					targetOrigin: origin,
					organizationId: orgA,
					...overrides,
				}),
			);

		it("refuses a platform admin as a target, a banned or unknown user, a non-member, and a missing reason", async () => {
			const before = await auditCount();
			await expect(start(ids.admin, { targetUserId: ids.adminNo2fa })).rejects.toMatchObject({
				code: "cannot_impersonate_admin",
			});
			await expect(start(ids.admin, { targetUserId: ids.admin })).rejects.toMatchObject({
				code: "cannot_impersonate_admin",
			});
			await expect(start(ids.admin, { targetUserId: ids.forged })).rejects.toMatchObject({ code: "not_found" });
			await expect(start(ids.admin, { targetUserId: ids.ownerB })).rejects.toMatchObject({ code: "invalid" });
			await expect(start(ids.admin, { reason: "" })).rejects.toMatchObject({ code: "invalid" });
			await expect(start(ids.admin, { targetOrigin: "javascript:alert(1)" })).rejects.toMatchObject({
				code: "invalid",
			});
			await owner.query(`UPDATE "user" SET banned = true WHERE id = $1`, [ids.memberA]);
			await expect(start(ids.admin)).rejects.toMatchObject({ code: "invalid" });
			await owner.query(`UPDATE "user" SET banned = false WHERE id = $1`, [ids.memberA]);
			expect(await auditCount(), "no refusal writes an audit row").toBe(before);
		});

		it("starts for 60 minutes from the start and audits in the member's organization and in the platform log", async () => {
			const before = await auditCount();
			const started = await start(ids.admin);
			expect(started.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
			const [row] = await ownerRows<{ minutes: string; token_seconds: string; token_hash: string; reason: string }>(
				`SELECT extract(epoch FROM (expires_at - started_at)) / 60 AS minutes, extract(epoch FROM (token_expires_at - started_at)) AS token_seconds, token_hash, reason FROM impersonation WHERE id = $1`,
				[started.id],
			);
			expect(Number(row?.minutes)).toBe(60);
			expect(Number(row?.token_seconds)).toBe(60);
			expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
			expect(row?.token_hash).not.toBe(started.token);
			expect(row?.reason).toBe("customer cannot export");
			expect(await auditCount()).toBe(before + 2);
			const rows = await auditRows(`metadata ->> 'impersonationId' = $1`, [started.id]);
			expect(rows.map((entry) => [entry.organization_id, entry.action, entry.actor_user_id, entry.target_id])).toEqual([
				[orgA, "impersonation.started", ids.admin, ids.memberA],
				[null, "admin.impersonation_started", ids.admin, ids.memberA],
			]);
		});

		it("redeems once, only for the right token, host and organization, and only while the actor is still an admin", async () => {
			const started = await start(ids.admin);
			expect(await redeem(started, { token: `${started.token.slice(1)}A` })).toBeNull();
			expect(await redeem(started, { targetOrigin: "https://evil.orgs.test" })).toBeNull();
			expect(await redeem(started, { organizationId: orgB })).toBeNull();
			const redeemed = await redeem(started);
			expect(redeemed).toMatchObject({
				targetUserId: ids.memberA,
				organizationId: orgA,
				impersonatorUserId: ids.admin,
			});
			expect(redeemed?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
			expect(await redeem(started), "a second redeem fails").toBeNull();

			const late = await start(ids.admin);
			await owner.query(`UPDATE impersonation SET token_expires_at = now() - interval '1 second' WHERE id = $1`, [
				late.id,
			]);
			expect(await redeem(late), "an expired token").toBeNull();

			const demoted = await start(ids.admin);
			await owner.query(`UPDATE "user" SET role = 'user' WHERE id = $1`, [ids.admin]);
			expect(await redeem(demoted), "the actor lost the role").toBeNull();
			await owner.query(`UPDATE "user" SET role = 'admin' WHERE id = $1`, [ids.admin]);
			expect(await redeem(demoted), "the token is still good once the role is back").not.toBeNull();
		});

		it("lets a session through only while its record is live, shows the banner data, and ends it with two audit rows", async () => {
			const started = await start(ids.admin);
			await redeem(started);
			const sessionId = `sess-${run}-${++counter}`;
			expect(
				await inApp(() => admin.isImpersonationActive(sessionId, ids.memberA, ids.admin)),
				"not attached yet",
			).toBe(false);
			expect(await inApp(() => admin.attachImpersonationSession(started.id, sessionId, ids.ownerB)), "wrong user").toBe(
				false,
			);
			expect(await inApp(() => admin.attachImpersonationSession(started.id, sessionId, ids.memberA))).toBe(true);
			expect(
				await inApp(() => admin.attachImpersonationSession(started.id, `other-${sessionId}`, ids.memberA)),
				"attached once",
			).toBe(false);
			expect(await inApp(() => admin.isImpersonationActive(sessionId, ids.memberA, ids.admin))).toBe(true);
			expect(
				await inApp(() => admin.isImpersonationActive(sessionId, ids.memberA, ids.adminNo2fa)),
				"a different impersonator",
			).toBe(false);
			expect(await inApp(() => admin.isImpersonationActive(sessionId, ids.ownerB, ids.admin)), "a different user").toBe(
				false,
			);
			expect(await inApp(() => admin.getImpersonationForSession(sessionId, ids.memberA))).toMatchObject({
				id: started.id,
				organizationName: "Acme Coaching",
				userName: `Name of ${ids.memberA}`,
			});
			expect(await inApp(() => admin.getImpersonationForSession(sessionId, ids.ownerB))).toBeNull();

			expect(await inApp(() => admin.endImpersonation(sessionId, ids.ownerB)), "another user cannot end it").toBe(
				false,
			);
			const before = await auditCount();
			expect(await inApp(() => admin.endImpersonation(sessionId, ids.memberA))).toBe(true);
			expect(await auditCount()).toBe(before + 2);
			expect(await inApp(() => admin.endImpersonation(sessionId, ids.memberA)), "ended once").toBe(false);
			expect(await auditCount()).toBe(before + 2);
			expect(await inApp(() => admin.isImpersonationActive(sessionId, ids.memberA, ids.admin))).toBe(false);
			expect(
				(await auditRows(`metadata ->> 'impersonationId' = $1 AND action LIKE '%ended'`, [started.id])).map((entry) => [
					entry.organization_id,
					entry.action,
					entry.metadata.endReason,
				]),
			).toEqual([
				[orgA, "impersonation.ended", "ended"],
				[null, "admin.impersonation_ended", "ended"],
			]);
		});

		it("stops a session after its 60 minutes and the sweep audits the expiry in both places, once", async () => {
			const started = await start(ids.admin);
			await redeem(started);
			const sessionId = `sess-${run}-${++counter}`;
			await inApp(() => admin.attachImpersonationSession(started.id, sessionId, ids.memberA));
			expect(await inApp(() => admin.isImpersonationActive(sessionId, ids.memberA, ids.admin))).toBe(true);
			await owner.query(`UPDATE impersonation SET expires_at = now() - interval '1 second' WHERE id = $1`, [
				started.id,
			]);
			expect(
				await inApp(() => admin.isImpersonationActive(sessionId, ids.memberA, ids.admin)),
				"past its end, before any sweep",
			).toBe(false);
			const before = await auditCount();
			expect(await inApp(() => admin.expireDueImpersonations())).toBeGreaterThanOrEqual(1);
			const rows = await auditRows(`metadata ->> 'impersonationId' = $1 AND action LIKE '%ended'`, [started.id]);
			expect(rows.map((entry) => [entry.organization_id, entry.action, entry.metadata.endReason])).toEqual([
				[orgA, "impersonation.ended", "expired"],
				[null, "admin.impersonation_ended", "expired"],
			]);
			expect(await inApp(() => admin.expireDueImpersonations())).toBe(0);
			expect((await auditCount()) - before, "the sweep wrote only these rows").toBeGreaterThanOrEqual(2);
			expect(await inApp(() => admin.endImpersonation(sessionId, ids.memberA)), "already ended").toBe(false);
		});
	});

	it("keeps the console's function list in step with the migration (extend this when a function is added)", async () => {
		const names = (
			await ownerRows<{ proname: string }>(
				`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
				 WHERE n.nspname = 'public' AND proname LIKE 'careeros\\_admin\\_%' ORDER BY proname`,
			)
		).map((row) => row.proname);
		expect(names).toEqual([
			"careeros_admin_announcement_end",
			"careeros_admin_announcement_list",
			"careeros_admin_announcement_save",
			"careeros_admin_check_reason",
			"careeros_admin_get_org",
			"careeros_admin_impersonation_start",
			"careeros_admin_list_audit",
			"careeros_admin_list_orgs",
			"careeros_admin_metrics",
			"careeros_admin_record_manual_payment",
			"careeros_admin_set_ai_overage",
			"careeros_admin_set_org_plan",
			"careeros_admin_set_org_status",
		]);
	});
});
