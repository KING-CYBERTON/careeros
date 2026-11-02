import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
	createIsolatedTestDatabase,
	withOrgContext as inOrgTransaction,
	type IsolatedTestDatabase,
} from "@careeros/testing";
import { Pool } from "pg";
import { withDatabasePool } from "@reactive-resume/db/client";

// P3-T01: plans, subscriptions, feature flags, the audit log and the entitlements, on a database of its own with every
// migration applied, read and written as the `careeros_app` role (NOSUPERUSER, NOBYPASSRLS). Skipped only when the
// CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const LEGACY_ORG = "billing-legacy";
const timePart = (id: string | undefined) => (id ?? "").replaceAll("-", "").slice(0, 12);
const MIGRATION = new URL("../../../migrations/20261102174208_plans_entitlements/", import.meta.url);

describe.skipIf(!configured)("plans, subscriptions, flags, audit log and entitlements", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `bill-a-${run}`,
		orgB: `bill-b-${run}`,
		orgC: `bill-c-${run}`,
		ownerA: `bill-owner-a-${run}`,
		memberA: `bill-member-a-${run}`,
		ownerB: `bill-owner-b-${run}`,
		admin: `bill-admin-${run}`,
	};
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let billing: typeof import("./index");

	const inApp = <T>(fn: () => T) => withDatabasePool(app, fn);
	/** One statement as `careeros_app` in the organization's context (a failure rolls back that transaction only). */
	const asApp = (orgId: string, sql: string, params: unknown[] = []) =>
		inOrgTransaction(app, orgId, (client) => client.query(sql, params));
	/** One statement as `careeros_app` with no organization context at all. */
	const asAppNoOrg = (sql: string, params: unknown[] = []) => app.query(sql, params);
	const ownerRows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
		(await owner.query<T>(sql, params)).rows;
	const denied = { code: "42501" };
	const inScope = <T>(orgId: string, fn: () => Promise<T>) =>
		inApp(async () => (await import("@careeros/tenancy")).withOrgContext(orgId, fn));

	const setPlan = (orgId: string, plan: string | null, status: string | null, actor: string | null = ids.admin) =>
		owner.query(`SELECT careeros_set_org_plan($1, $2, $3, $4, 'test')`, [orgId, plan, status, actor]);
	const setSubscription = (orgId: string, fields: unknown, source = "test") =>
		owner.query(`SELECT careeros_set_subscription($1, $2::jsonb, $3, $4)`, [
			orgId,
			JSON.stringify(fields),
			ids.admin,
			source,
		]);
	const auditActions = async (orgId: string) =>
		(
			await ownerRows<{ action: string }>(`SELECT action FROM audit_log WHERE organization_id = $1 ORDER BY id`, [
				orgId,
			])
		).map((row) => row.action);

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("billing_t01", {
			// An organization that exists before the migration: the backfill must put it on the personal plan.
			onMigration: async ({ directory, phase }, client) => {
				if (phase === "before" && directory.endsWith("_plans_entitlements"))
					await client.query(`INSERT INTO organization (id, name, slug) VALUES ($1, 'Legacy', $1)`, [LEGACY_ORG]);
			},
		});
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		for (const user of Object.values(ids).filter(
			(id) => id.includes("owner") || id.includes("member") || id === ids.admin,
		))
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[user],
			);
		for (const org of [ids.orgA, ids.orgB, ids.orgC])
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
		await owner.query(
			`INSERT INTO member (id, organization_id, user_id, role) VALUES ('m1', $1, $2, 'owner'), ('m2', $1, $3, 'member')`,
			[ids.orgA, ids.ownerA, ids.memberA],
		);
		await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ('m3', $1, $2, 'owner')`, [
			ids.orgB,
			ids.ownerB,
		]);
		billing = await import("./index");
	}, 180_000);

	afterAll(async () => {
		await owner?.end();
		await app?.end();
		await database?.drop();
	});

	describe("the migration", () => {
		it("backfills an existing organization to the personal plan, active, with a none subscription", async () => {
			const [org] = await ownerRows(`SELECT plan_id, status, status_changed_at FROM organization WHERE id = $1`, [
				LEGACY_ORG,
			]);
			expect(org).toEqual({ plan_id: "personal", status: "active", status_changed_at: null });
			const [subscription] = await ownerRows(
				`SELECT plan_id, provider, status, seats, billing_interval, ai_overage_allowed FROM subscription WHERE organization_id = $1`,
				[LEGACY_ORG],
			);
			expect(subscription).toEqual({
				plan_id: "personal",
				provider: "none",
				status: "none",
				seats: 1,
				billing_interval: null,
				ai_overage_allowed: false,
			});
		});

		it("seeds the five plans with the agreed shape", async () => {
			const plans = await ownerRows<{
				id: string;
				seat_limit: number | null;
				ai_credits_per_seat: number;
				price_monthly_usd_cents: number | null;
				features: Record<string, boolean>;
				active: boolean;
			}>(`SELECT id, seat_limit, ai_credits_per_seat, price_monthly_usd_cents, features, active FROM plan ORDER BY id`);
			const byId = new Map(plans.map((plan) => [plan.id, plan]));
			expect([...byId.keys()].sort()).toEqual(["enterprise", "personal", "pro", "starter", "trial"]);
			expect(byId.get("personal")).toMatchObject({ seat_limit: 1, active: true });
			expect(byId.get("personal")?.features).toMatchObject({
				custom_domain: false,
				admin_analytics: false,
				sso: false,
			});
			expect(byId.get("trial")?.seat_limit).toBe(5);
			expect(byId.get("starter")?.seat_limit).toBe(50);
			expect(byId.get("pro")?.seat_limit).toBeNull();
			expect(byId.get("enterprise")).toMatchObject({ seat_limit: null, price_monthly_usd_cents: null });
			for (const plan of plans)
				for (const key of billing.FEATURE_KEYS)
					if (plan.id !== "personal") expect(typeof plan.features[key]).toBe("boolean");
			expect(byId.get("enterprise")?.features.sso).toBe(true);
			expect(byId.get("pro")?.features.sso).toBe(false);
		});

		it("gives a new organization its subscription row, whoever inserts it", async () => {
			const [created] = await ownerRows(
				`SELECT plan_id, status, provider, seats FROM subscription WHERE organization_id = $1`,
				[ids.orgA],
			);
			expect(created).toEqual({ plan_id: "personal", status: "none", provider: "none", seats: 1 });
			// What Better Auth's organization plugin inserts: no plan columns. As the app role, in no organization context.
			const id = `plugin-${run}`;
			await asAppNoOrg(
				`INSERT INTO organization (id, name, slug, logo, metadata) VALUES ($1, 'Plugin', $1, NULL, NULL)`,
				[id],
			);
			const [row] = await ownerRows(
				`SELECT o.plan_id, o.status, s.status AS subscription_status FROM organization o JOIN subscription s ON s.organization_id = o.id WHERE o.id = $1`,
				[id],
			);
			expect(row).toEqual({ plan_id: "personal", status: "active", subscription_status: "none" });
		});

		it("enforces the check constraints", async () => {
			await expect(
				owner.query(`UPDATE organization SET status = 'gone' WHERE id = $1`, [ids.orgC]),
			).rejects.toMatchObject({ code: "23514" });
			await expect(
				owner.query(`UPDATE subscription SET seats = 0 WHERE organization_id = $1`, [ids.orgC]),
			).rejects.toMatchObject({ code: "23514" });
			await expect(
				owner.query(`UPDATE subscription SET provider = 'cash' WHERE organization_id = $1`, [ids.orgC]),
			).rejects.toMatchObject({ code: "23514" });
			await expect(
				owner.query(`INSERT INTO feature_flag (id, key, enabled) VALUES ('f-bad', 'Bad Key', true)`),
			).rejects.toMatchObject({ code: "23514" });
			await expect(owner.query(`INSERT INTO audit_log (action) VALUES ('Bad Action')`)).rejects.toMatchObject({
				code: "23514",
			});
			await expect(
				owner.query(`UPDATE organization SET plan_id = 'nope' WHERE id = $1`, [ids.orgC]),
			).rejects.toMatchObject({ code: "23503" });
		});

		it("treats a null organization as one value in the flag key index", async () => {
			await owner.query(
				`INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ($1, NULL, 'uniq_key', true)`,
				[`g1-${run}`],
			);
			await expect(
				owner.query(
					`INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ($1, NULL, 'uniq_key', false)`,
					[`g2-${run}`],
				),
			).rejects.toMatchObject({ code: "23505" });
			// The same key for an organization is a different flag.
			await owner.query(
				`INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ($1, $2, 'uniq_key', false)`,
				[`o1-${run}`, ids.orgA],
			);
			await expect(
				owner.query(`INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ($1, $2, 'uniq_key', true)`, [
					`o2-${run}`,
					ids.orgA,
				]),
			).rejects.toMatchObject({ code: "23505" });
			await owner.query(`DELETE FROM feature_flag WHERE key = 'uniq_key'`);
		});

		it("generates time-sortable ids for audit rows written in SQL", async () => {
			const rows = await ownerRows<{ id: string }>(`SELECT careeros_uuidv7()::text AS id FROM generate_series(1, 5)`);
			for (const { id } of rows)
				expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			await new Promise((resolve) => setTimeout(resolve, 5));
			const [later] = await ownerRows<{ id: string }>(`SELECT careeros_uuidv7()::text AS id`);
			expect(timePart(later?.id) >= timePart(rows[0]?.id)).toBe(true);
		});
	});

	describe("what the app role cannot do", () => {
		it("has no write privilege on plan, subscription or feature_flag, and no update or delete on audit_log", async () => {
			const privilege = async (table: string, kind: string) =>
				(await ownerRows<{ ok: boolean }>(`SELECT has_table_privilege('careeros_app', $1, $2) AS ok`, [table, kind]))[0]
					?.ok === true;
			for (const table of ["plan", "subscription", "feature_flag", "audit_log"])
				expect(await privilege(table, "SELECT")).toBe(true);
			for (const table of ["plan", "subscription", "feature_flag"])
				for (const kind of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"])
					expect(await privilege(table, kind), `${table} ${kind}`).toBe(false);
			expect(await privilege("audit_log", "INSERT")).toBe(true);
			for (const kind of ["UPDATE", "DELETE", "TRUNCATE"])
				expect(await privilege("audit_log", kind), `audit_log ${kind}`).toBe(false);
		});

		it("cannot change an organization's status, plan or status_changed_at", async () => {
			for (const set of ["status = 'suspended'", "plan_id = 'enterprise'", "status_changed_at = now()"])
				await expect(
					asApp(ids.orgA, `UPDATE organization SET ${set} WHERE id = $1`, [ids.orgA]),
					set,
				).rejects.toMatchObject(denied);
			// A statement that sets a column to its current value changes nothing and is allowed, as is any other column.
			await asApp(ids.orgA, `UPDATE organization SET plan_id = plan_id, name = 'Renamed' WHERE id = $1`, [ids.orgA]);
			const [row] = await ownerRows(`SELECT plan_id, status, name FROM organization WHERE id = $1`, [ids.orgA]);
			expect(row).toEqual({ plan_id: "personal", status: "active", name: "Renamed" });
		});

		it("cannot get round the guard with a custom setting, a multi-row update or an upsert", async () => {
			await expect(
				inOrgTransaction(app, ids.orgA, async (client) => {
					await client.query(`SELECT set_config('careeros.billing_write', 'on', true)`);
					return client.query(`UPDATE organization SET plan_id = 'pro' WHERE id = $1`, [ids.orgA]);
				}),
			).rejects.toMatchObject(denied);
			await expect(asApp(ids.orgA, `UPDATE organization SET status = 'trial'`)).rejects.toMatchObject(denied);
			await expect(
				asApp(
					ids.orgA,
					`INSERT INTO organization (id, name, slug) VALUES ($1, 'x', 'x') ON CONFLICT (id) DO UPDATE SET plan_id = 'pro'`,
					[ids.orgA],
				),
			).rejects.toMatchObject(denied);
			const rows = await ownerRows(`SELECT id FROM organization WHERE plan_id <> 'personal' OR status <> 'active'`);
			expect(rows).toEqual([]);
		});

		it("cannot create an organization on a paid plan or in another status", async () => {
			for (const columns of ["plan_id, status", "status", "status_changed_at"]) {
				const values = columns === "plan_id, status" ? `'pro', 'active'` : columns === "status" ? `'trial'` : `now()`;
				await expect(
					asAppNoOrg(`INSERT INTO organization (id, name, slug, ${columns}) VALUES ($1, 'x', $1, ${values})`, [
						`forged-${run}-${columns.length}`,
					]),
				).rejects.toMatchObject(denied);
			}
		});

		it("cannot write the subscription", async () => {
			await expect(
				asApp(ids.orgA, `UPDATE subscription SET seats = 500 WHERE organization_id = $1`, [ids.orgA]),
			).rejects.toMatchObject(denied);
			await expect(
				asApp(
					ids.orgA,
					`UPDATE subscription SET plan_id = 'enterprise', status = 'active' WHERE organization_id = $1`,
					[ids.orgA],
				),
			).rejects.toMatchObject(denied);
			await expect(
				asApp(ids.orgA, `DELETE FROM subscription WHERE organization_id = $1`, [ids.orgA]),
			).rejects.toMatchObject(denied);
			await expect(
				asApp(ids.orgA, `INSERT INTO subscription (organization_id, plan_id) VALUES ($1, 'pro')`, [`${ids.orgA}-x`]),
			).rejects.toMatchObject(denied);
			const [row] = await ownerRows(`SELECT plan_id, seats, status FROM subscription WHERE organization_id = $1`, [
				ids.orgA,
			]);
			expect(row).toEqual({ plan_id: "personal", seats: 1, status: "none" });
		});

		it("cannot write plans or flags", async () => {
			await expect(asApp(ids.orgA, `UPDATE plan SET seat_limit = NULL`)).rejects.toMatchObject(denied);
			await expect(asApp(ids.orgA, `DELETE FROM plan WHERE id = 'pro'`)).rejects.toMatchObject(denied);
			await expect(asApp(ids.orgA, `INSERT INTO plan (id, name) VALUES ('free2', 'x')`)).rejects.toMatchObject(denied);
			await expect(
				asApp(ids.orgA, `INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ('f1', $1, 'sso', true)`, [
					ids.orgA,
				]),
			).rejects.toMatchObject(denied);
			await expect(asApp(ids.orgA, `UPDATE feature_flag SET enabled = true`)).rejects.toMatchObject(denied);
			await expect(asApp(ids.orgA, `DELETE FROM feature_flag`)).rejects.toMatchObject(denied);
		});

		it("cannot change or delete audit rows, and can insert only for its own organization", async () => {
			const own = await asApp(
				ids.orgA,
				`INSERT INTO audit_log (organization_id, action) VALUES ($1, 'test.own') RETURNING id`,
				[ids.orgA],
			);
			const id = own.rows[0].id as string;
			await expect(
				asApp(ids.orgA, `UPDATE audit_log SET action = 'test.edited' WHERE id = $1`, [id]),
			).rejects.toMatchObject(denied);
			await expect(asApp(ids.orgA, `DELETE FROM audit_log WHERE id = $1`, [id])).rejects.toMatchObject(denied);
			await expect(asApp(ids.orgA, `TRUNCATE audit_log`)).rejects.toMatchObject(denied);
			await expect(
				asApp(ids.orgA, `INSERT INTO audit_log (organization_id, action) VALUES ($1, 'test.other')`, [ids.orgB]),
			).rejects.toMatchObject(denied);
			await expect(
				asApp(ids.orgA, `INSERT INTO audit_log (organization_id, action) VALUES (NULL, 'test.platform')`),
			).rejects.toMatchObject(denied);
			await expect(
				asAppNoOrg(`INSERT INTO audit_log (organization_id, action) VALUES ($1, 'test.noorg')`, [ids.orgA]),
			).rejects.toMatchObject(denied);
			const [row] = await ownerRows(`SELECT action FROM audit_log WHERE id = $1`, [id]);
			expect(row).toEqual({ action: "test.own" });
			await owner.query(`DELETE FROM audit_log WHERE id = $1`, [id]);
		});
	});

	describe("row-level security", () => {
		it("shows an organization only its own subscription", async () => {
			expect((await asApp(ids.orgA, `SELECT organization_id FROM subscription`)).rows).toEqual([
				{ organization_id: ids.orgA },
			]);
			expect(
				(await asApp(ids.orgB, `SELECT organization_id FROM subscription WHERE organization_id = $1`, [ids.orgA])).rows,
			).toEqual([]);
			expect((await asAppNoOrg(`SELECT 1 FROM subscription`)).rowCount).toBe(0);
		});

		it("shows an organization its own flags and the global ones, never another organization's", async () => {
			await owner.query(
				`INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ($1, $2, 'only_a', true), ($3, $4, 'only_b', true), ($5, NULL, 'everyone', true)`,
				[`fa-${run}`, ids.orgA, `fb-${run}`, ids.orgB, `fg-${run}`],
			);
			const keys = async (orgId: string) =>
				(await asApp(orgId, `SELECT key FROM feature_flag ORDER BY key`)).rows.map((row) => row.key as string);
			expect(await keys(ids.orgA)).toEqual(["everyone", "only_a"]);
			expect(await keys(ids.orgB)).toEqual(["everyone", "only_b"]);
			// With no organization at all, only the global flag matches.
			expect((await asAppNoOrg(`SELECT key FROM feature_flag`)).rows.map((row) => row.key)).toEqual(["everyone"]);
			await owner.query(`DELETE FROM feature_flag WHERE key IN ('only_a', 'only_b', 'everyone')`);
		});

		it("shows the audit log of the current organization only, and never platform rows", async () => {
			await owner.query(`INSERT INTO audit_log (organization_id, action) VALUES ($1, 'rls.a'), ($2, 'rls.b')`, [
				ids.orgA,
				ids.orgB,
			]);
			await owner.query(`SELECT careeros_audit_platform($1, NULL, 'rls.platform', NULL, NULL, '{}', NULL)`, [
				ids.admin,
			]);
			const actions = async (orgId: string) =>
				(await asApp(orgId, `SELECT action FROM audit_log WHERE action LIKE 'rls.%'`)).rows.map((row) => row.action);
			expect(await actions(ids.orgA)).toEqual(["rls.a"]);
			expect(await actions(ids.orgB)).toEqual(["rls.b"]);
			expect((await asAppNoOrg(`SELECT 1 FROM audit_log WHERE action LIKE 'rls.%'`)).rowCount).toBe(0);
		});

		it("lets every role read the plans", async () => {
			expect((await asApp(ids.orgA, `SELECT id FROM plan`)).rowCount).toBe(5);
			expect((await asAppNoOrg(`SELECT id FROM plan`)).rowCount).toBe(5);
		});
	});

	describe("definer functions", () => {
		it("careeros_set_org_plan changes plan and status together with the subscription and two audit rows", async () => {
			await setPlan(ids.orgC, "pro", "trial");
			const [org] = await ownerRows(
				`SELECT plan_id, status, status_changed_at IS NOT NULL AS changed FROM organization WHERE id = $1`,
				[ids.orgC],
			);
			expect(org).toEqual({ plan_id: "pro", status: "trial", changed: true });
			const [subscription] = await ownerRows(`SELECT plan_id FROM subscription WHERE organization_id = $1`, [ids.orgC]);
			expect(subscription).toEqual({ plan_id: "pro" });
			const rows = await ownerRows<{
				action: string;
				actor_user_id: string;
				target_id: string;
				metadata: Record<string, string>;
			}>(
				`SELECT action, actor_user_id, target_id, metadata FROM audit_log WHERE organization_id = $1 ORDER BY action`,
				[ids.orgC],
			);
			expect(rows.map((row) => row.action)).toEqual(["org.plan_changed", "org.status_changed"]);
			expect(rows[0]).toMatchObject({
				actor_user_id: ids.admin,
				target_id: ids.orgC,
				metadata: { from: "personal", to: "pro", reason: "test" },
			});
			expect(rows[1]?.metadata).toMatchObject({ from: "active", to: "trial" });
		});

		it("careeros_set_org_plan writes only what changed, keeps status_changed_at on a plan-only change, and writes nothing for a no-op", async () => {
			const [before] = await ownerRows<{ at: Date }>(`SELECT status_changed_at AS at FROM organization WHERE id = $1`, [
				ids.orgC,
			]);
			await setPlan(ids.orgC, "starter", null);
			const [after] = await ownerRows<{ at: Date; status: string; plan_id: string }>(
				`SELECT status_changed_at AS at, status, plan_id FROM organization WHERE id = $1`,
				[ids.orgC],
			);
			expect(after).toMatchObject({ status: "trial", plan_id: "starter" });
			expect(after?.at.getTime()).toBe(before?.at.getTime());
			const count = (await auditActions(ids.orgC)).length;
			await setPlan(ids.orgC, "starter", "trial");
			await setPlan(ids.orgC, null, null);
			expect((await auditActions(ids.orgC)).length).toBe(count);
			await setPlan(ids.orgC, null, "suspended", null);
			expect((await auditActions(ids.orgC)).length).toBe(count + 1);
		});

		it("careeros_set_org_plan rejects an unknown organization, plan or status and changes nothing", async () => {
			await expect(setPlan("no-such-org", "pro", null)).rejects.toThrow(/unknown organization/);
			await expect(setPlan(ids.orgB, "platinum", null)).rejects.toThrow(/unknown plan/);
			await expect(setPlan(ids.orgB, null, "frozen")).rejects.toThrow(/unknown status/);
			expect(await auditActions(ids.orgB)).not.toContain("org.plan_changed");
			const [row] = await ownerRows(`SELECT plan_id, status FROM organization WHERE id = $1`, [ids.orgB]);
			expect(row).toEqual({ plan_id: "personal", status: "active" });
		});

		it("careeros_set_subscription updates allow-listed fields and writes one audit row", async () => {
			await setSubscription(
				ids.orgB,
				{
					provider: "manual",
					status: "active",
					seats: 12,
					billing_interval: "year",
					provider_customer_id: "cus_test",
					current_period_start: "2026-11-01T00:00:00Z",
					current_period_end: "2027-11-01T00:00:00Z",
					ai_overage_allowed: true,
				},
				"manual_invoice",
			);
			const [row] = await ownerRows(
				`SELECT provider, status, seats, billing_interval, provider_customer_id, ai_overage_allowed, plan_id,
				        current_period_end = '2027-11-01T00:00:00Z' AS period_ok FROM subscription WHERE organization_id = $1`,
				[ids.orgB],
			);
			expect(row).toEqual({
				provider: "manual",
				status: "active",
				seats: 12,
				billing_interval: "year",
				provider_customer_id: "cus_test",
				ai_overage_allowed: true,
				plan_id: "personal",
				period_ok: true,
			});
			const [audit] = await ownerRows<{ metadata: { source: string; fields: Record<string, unknown> } }>(
				`SELECT metadata FROM audit_log WHERE organization_id = $1 AND action = 'subscription.updated'`,
				[ids.orgB],
			);
			expect(audit?.metadata.source).toBe("manual_invoice");
			expect(audit?.metadata.fields).toMatchObject({ seats: 12, provider: "manual" });
			// A null clears a nullable field; fields that are not named stay.
			await setSubscription(ids.orgB, { provider_customer_id: null });
			const [cleared] = await ownerRows(
				`SELECT provider_customer_id, seats FROM subscription WHERE organization_id = $1`,
				[ids.orgB],
			);
			expect(cleared).toEqual({ provider_customer_id: null, seats: 12 });
		});

		it("careeros_set_subscription rejects unknown fields, the plan, bad values and a missing source", async () => {
			const before = (await auditActions(ids.orgB)).length;
			await expect(setSubscription(ids.orgB, { seats: 3, nope: 1 })).rejects.toThrow(/unknown fields nope/);
			await expect(setSubscription(ids.orgB, { plan_id: "enterprise" })).rejects.toThrow(/unknown fields plan_id/);
			await expect(setSubscription(ids.orgB, { organization_id: ids.orgA })).rejects.toThrow(/unknown fields/);
			await expect(setSubscription(ids.orgB, { created_at: "2020-01-01T00:00:00Z" })).rejects.toThrow(/unknown fields/);
			await expect(setSubscription(ids.orgB, { seats: 0 })).rejects.toMatchObject({ code: "23514" });
			await expect(setSubscription(ids.orgB, { status: "paid" })).rejects.toMatchObject({ code: "23514" });
			await expect(setSubscription(ids.orgB, { seats: "many" })).rejects.toThrow();
			await expect(setSubscription(ids.orgB, [])).rejects.toThrow(/JSON object/);
			await expect(setSubscription(ids.orgB, { seats: 2 }, " ")).rejects.toThrow(/source is required/);
			await expect(setSubscription("no-such-org", { seats: 2 })).rejects.toThrow(/no subscription/);
			expect((await auditActions(ids.orgB)).length).toBe(before);
			const [row] = await ownerRows(`SELECT seats, plan_id FROM subscription WHERE organization_id = $1`, [ids.orgB]);
			expect(row).toEqual({ seats: 12, plan_id: "personal" });
		});

		it("careeros_audit_platform writes a row without an organization and returns its id", async () => {
			const written = await ownerRows<{ id: string }>(
				`SELECT careeros_audit_platform($1, $2, 'admin.impersonation_started', 'user', $3, '{"minutes": 30}', '203.0.113.7') AS id`,
				[ids.admin, ids.ownerA, ids.memberA],
			);
			const id = written[0]?.id ?? "";
			const [row] = await ownerRows(
				`SELECT organization_id, actor_user_id, impersonator_user_id, action, target_type, target_id, metadata, ip FROM audit_log WHERE id = $1`,
				[id],
			);
			expect(row).toEqual({
				organization_id: null,
				actor_user_id: ids.admin,
				impersonator_user_id: ids.ownerA,
				action: "admin.impersonation_started",
				target_type: "user",
				target_id: ids.memberA,
				metadata: { minutes: 30 },
				ip: "203.0.113.7",
			});
			await expect(
				owner.query(`SELECT careeros_audit_platform(NULL, NULL, 'Bad Action', NULL, NULL, NULL, NULL)`),
			).rejects.toMatchObject({ code: "23514" });
			// The app role runs the function (only TypeScript callers decide who may), but cannot read the row it wrote.
			const viaApp = await asApp(
				ids.orgA,
				`SELECT careeros_audit_platform(NULL, NULL, 'app.platform_write', NULL, NULL, NULL, NULL) AS id`,
			);
			expect(viaApp.rows[0].id).toBeTruthy();
			expect((await asApp(ids.orgA, `SELECT 1 FROM audit_log WHERE id = $1`, [viaApp.rows[0].id])).rowCount).toBe(0);
		});

		it("is executable by the app role and not by PUBLIC", async () => {
			const rows = await ownerRows<{ proname: string; app: boolean; public_: boolean; definer: boolean }>(
				`SELECT p.proname, has_function_privilege('careeros_app', p.oid, 'EXECUTE') AS app,
				        has_function_privilege('public', p.oid, 'EXECUTE') AS public_, p.prosecdef AS definer
				   FROM pg_proc p WHERE p.proname IN ('careeros_set_org_plan', 'careeros_set_subscription', 'careeros_audit_platform')`,
			);
			expect(rows).toHaveLength(3);
			for (const row of rows) expect(row, row.proname).toMatchObject({ app: true, public_: false, definer: true });
		});
	});

	describe("getEntitlements", () => {
		it("answers for a fresh personal organization", async () => {
			const entitlements = await inScope(ids.orgA, () => billing.getEntitlements(ids.orgA));
			expect(entitlements).toMatchObject({
				planId: "personal",
				status: "active",
				seatLimit: 1,
				seatsUsed: 2,
				aiCreditsPerSeat: 50,
				// max(seats paid = 1, members = 2) x 50
				aiCreditsTotal: 100,
				overageAllowed: false,
				readOnly: false,
			});
			for (const key of billing.FEATURE_KEYS) expect(entitlements.features).toHaveProperty(key);
			expect(entitlements.features.custom_domain).toBe(false);
			expect(entitlements.features.platform_ai).toBe(true);
		});

		it("counts pending invitations that have not expired, and nothing else, as seats", async () => {
			const invite = (id: string, status: string, expires: string) =>
				owner.query(
					`INSERT INTO invitation (id, organization_id, email, role, status, expires_at, inviter_id) VALUES ($1, $2, $3, 'member', $4, now() + $5::interval, $6)`,
					[`${id}-${run}`, ids.orgA, `${id}-${run}@example.test`, status, expires, ids.ownerA],
				);
			await invite("inv-ok", "pending", "1 day");
			await invite("inv-ok2", "pending", "2 days");
			await invite("inv-expired", "pending", "-1 day");
			await invite("inv-accepted", "accepted", "1 day");
			await invite("inv-canceled", "canceled", "1 day");
			const entitlements = await inScope(ids.orgA, () => billing.getEntitlements(ids.orgA));
			expect(entitlements.seatsUsed).toBe(2 + 2);
			// Invitations do not enlarge the AI pool.
			expect(entitlements.aiCreditsTotal).toBe(100);
		});

		it("follows plan, status, subscription and flag changes in the D4 order", async () => {
			await setPlan(ids.orgA, "pro", "past_due");
			await setSubscription(ids.orgA, { seats: 10, ai_overage_allowed: true });
			await owner.query(
				`INSERT INTO feature_flag (id, organization_id, key, enabled) VALUES ($1, NULL, 'beta_ui', true), ($2, NULL, 'job_discovery', false), ($3, $4, 'custom_domain', false), ($5, $4, 'beta_ui', false), ($6, NULL, 'only_global', true)`,
				[`g-beta-${run}`, `g-jd-${run}`, `o-cd-${run}`, ids.orgA, `o-beta-${run}`, `g-only-${run}`],
			);
			try {
				const entitlements = await inScope(ids.orgA, () => billing.getEntitlements(ids.orgA));
				expect(entitlements).toMatchObject({
					planId: "pro",
					status: "past_due",
					seatLimit: null,
					aiCreditsPerSeat: 300,
					// max(10 paid, 2 members) x 300
					aiCreditsTotal: 3000,
					overageAllowed: true,
					readOnly: false,
				});
				// 1. The organization's flag beats the plan (custom_domain: plan true, org false) and the global flag (beta_ui: global true, org false).
				expect(entitlements.features.custom_domain).toBe(false);
				expect(entitlements.features.beta_ui).toBe(false);
				// 2. The plan beats the global flag (job_discovery: plan true, global false).
				expect(entitlements.features.job_discovery).toBe(true);
				expect(entitlements.features.admin_analytics).toBe(true);
				// 3. The global flag applies where nothing above it has an opinion.
				expect(entitlements.features.only_global).toBe(true);
				// 4. The code default (off) applies when nothing has an opinion at all.
				expect(entitlements.features.sso).toBe(false);
				// Another organization sees the global flag, not Org A's override, and not Org A's custom_domain flag.
				const other = await inScope(ids.orgB, () => billing.getEntitlements(ids.orgB));
				expect(other.features.beta_ui).toBe(true);
				expect(other.features.custom_domain).toBe(false);
				expect(other.features.only_global).toBe(true);
			} finally {
				await owner.query(
					`DELETE FROM feature_flag WHERE key IN ('beta_ui', 'job_discovery', 'custom_domain', 'only_global')`,
				);
			}
		});

		it("is read-only when suspended and reports isFeatureEnabled", async () => {
			await setPlan(ids.orgA, "enterprise", "suspended");
			expect((await inScope(ids.orgA, () => billing.getEntitlements(ids.orgA))).readOnly).toBe(true);
			expect(await inScope(ids.orgA, () => billing.isFeatureEnabled(ids.orgA, "sso"))).toBe(true);
			expect(await inScope(ids.orgA, () => billing.isFeatureEnabled(ids.orgA, "custom_domain"))).toBe(true);
			expect(await inScope(ids.orgB, () => billing.isFeatureEnabled(ids.orgB, "sso"))).toBe(false);
		});

		it("caches within one request only", async () => {
			await setPlan(ids.orgA, "starter", "active");
			await inApp(() =>
				billing.runWithEntitlementsCache(async () => {
					const tenancy = await import("@careeros/tenancy");
					const first = await tenancy.withOrgContext(ids.orgA, () => billing.getEntitlements(ids.orgA));
					await setPlan(ids.orgA, "pro", null);
					const second = await tenancy.withOrgContext(ids.orgA, () => billing.getEntitlements(ids.orgA));
					expect(first.planId).toBe("starter");
					expect(second).toBe(first);
				}),
			);
			// The next request sees the change.
			expect((await inScope(ids.orgA, () => billing.getEntitlements(ids.orgA))).planId).toBe("pro");
		});

		it("cannot be asked about another organization from inside a scope", async () => {
			await expect(inScope(ids.orgA, () => billing.getEntitlements(ids.orgB))).rejects.toMatchObject({
				code: "org_switch_in_scope",
			});
		});

		it("rejects an unknown organization", async () => {
			await expect(inScope("no-such-org", () => billing.getEntitlements("no-such-org"))).rejects.toMatchObject({
				code: "org_not_found",
			});
		});
	});

	describe("audit()", () => {
		it("adds a row for the current organization, as the app role", async () => {
			const id = await inScope(ids.orgA, () =>
				billing.audit(
					{ actorUserId: ids.ownerA, ip: "198.51.100.4" },
					"member.removed",
					{ type: "user", id: ids.memberA },
					{ reason: "left" },
				),
			);
			const [row] = await ownerRows(
				`SELECT organization_id, actor_user_id, impersonator_user_id, action, target_type, target_id, metadata, ip FROM audit_log WHERE id = $1`,
				[id],
			);
			expect(row).toEqual({
				organization_id: ids.orgA,
				actor_user_id: ids.ownerA,
				impersonator_user_id: null,
				action: "member.removed",
				target_type: "user",
				target_id: ids.memberA,
				metadata: { reason: "left" },
				ip: "198.51.100.4",
			});
		});

		it("sorts by time and refuses a bad action or a call outside an organization", async () => {
			const first = await inScope(ids.orgB, () => billing.audit({ actorUserId: null }, "test.first"));
			await new Promise((resolve) => setTimeout(resolve, 3));
			const second = await inScope(ids.orgB, () =>
				billing.audit({ actorUserId: null, impersonatorUserId: ids.admin }, "test.second"),
			);
			expect(second > first).toBe(true);
			await expect(inScope(ids.orgB, () => billing.audit({ actorUserId: null }, "Not Valid"))).rejects.toMatchObject({
				code: "invalid_audit_action",
			});
			await expect(inApp(() => billing.audit({ actorUserId: null }, "test.nowhere"))).rejects.toMatchObject({
				code: "org_required",
			});
		});
	});

	describe("down.sql", () => {
		it("refuses while data exists, then reverts the migration, and the migration applies again", async () => {
			const down = await readFile(new URL("down.sql", MIGRATION), "utf8");
			const up = await readFile(new URL("migration.sql", MIGRATION), "utf8");
			const scratch = await createIsolatedTestDatabase("billing_down");
			const client = new Pool({ connectionString: scratch.ownerUrl });
			try {
				await client.query(`INSERT INTO organization (id, name, slug) VALUES ('down-org', 'Down', 'down-org')`);
				// The organization has left the defaults (plan 'pro') and has an audit row: the down migration refuses.
				await client.query(`SELECT careeros_set_org_plan('down-org', 'pro', NULL, NULL, 'x')`);
				await expect(client.query(down)).rejects.toThrow(/down refused/);
				const connection = await client.connect();
				try {
					await connection.query(`SET careeros.allow_data_loss = 'yes'`);
					await connection.query(down);
					const gone = await connection.query(
						`SELECT to_regclass('public.plan') AS plan, to_regclass('public.audit_log') AS audit, to_regprocedure('careeros_set_org_plan(text,text,text,text,text)') AS fn`,
					);
					expect(gone.rows[0]).toEqual({ plan: null, audit: null, fn: null });
					const columns = await connection.query(
						`SELECT column_name FROM information_schema.columns WHERE table_name = 'organization' AND column_name IN ('status', 'plan_id', 'status_changed_at')`,
					);
					expect(columns.rowCount).toBe(0);
					await connection.query(up);
					const back = await connection.query(
						`SELECT o.plan_id, s.plan_id AS subscription_plan FROM organization o JOIN subscription s ON s.organization_id = o.id WHERE o.id = 'down-org'`,
					);
					expect(back.rows).toEqual([{ plan_id: "personal", subscription_plan: "personal" }]);
				} finally {
					connection.release();
				}
			} finally {
				await client.end();
				await scratch.drop();
			}
		}, 120_000);
	});
});
