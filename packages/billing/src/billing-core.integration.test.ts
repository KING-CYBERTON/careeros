import type { BillingEvent } from "./events";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";
import { withDatabasePool } from "@reactive-resume/db/client";

// P3-T04: billing core on a database of its own with every migration applied, as the `careeros_app` role (NOSUPERUSER,
// NOBYPASSRLS). Event intake, idempotency, the periodic job, trials, manual payments and the privileges around
// `billing_event`. Skipped only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-02T12:00:00.000Z");
const at = (days: number, from: Date = NOW) => new Date(from.getTime() + days * DAY);

describe.skipIf(!configured)("billing core: events, trials, jobs and manual payments", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		admin: `bc-admin-${run}`,
		ownerA: `bc-owner-a-${run}`,
		member1: `bc-member-1-${run}`,
		member2: `bc-member-2-${run}`,
		member3: `bc-member-3-${run}`,
	};
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let billing: typeof import("./index");
	let counter = 0;

	const inApp = <T>(fn: () => Promise<T>) => withDatabasePool(app, fn);
	const ownerRows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
		(await owner.query<T>(sql, params)).rows;
	const denied = { code: "42501" };

	const newOrg = async (members = 1) => {
		const id = `bc-org-${run}-${++counter}`;
		await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [id]);
		const users = [ids.ownerA, ids.member1, ids.member2, ids.member3].slice(0, members);
		for (const [index, user] of users.entries())
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
				`m-${id}-${index}`,
				id,
				user,
				index === 0 ? "owner" : "member",
			]);
		return id;
	};
	const state = async (orgId: string) => {
		const [row] = await ownerRows<{
			status: string;
			plan_id: string;
			sub_status: string;
			provider: string;
			seats: number;
			billing_interval: string | null;
			current_period_start: Date | null;
			current_period_end: Date | null;
			trial_ends_at: Date | null;
			grace_ends_at: Date | null;
			sub_plan: string;
		}>(
			`SELECT o.status, o.plan_id, s.status AS sub_status, s.provider, s.seats, s.billing_interval, s.current_period_start,
				s.current_period_end, s.trial_ends_at, s.grace_ends_at, s.plan_id AS sub_plan
			 FROM organization o JOIN subscription s ON s.organization_id = o.id WHERE o.id = $1`,
			[orgId],
		);
		if (!row) throw new Error("no state");
		return row;
	};
	const auditActions = async (orgId: string) =>
		(
			await ownerRows<{ action: string }>(`SELECT action FROM audit_log WHERE organization_id = $1 ORDER BY id`, [
				orgId,
			])
		).map((row) => row.action);
	const events = async (orgId: string) =>
		await ownerRows<{
			provider: string;
			provider_event_id: string;
			outcome: string;
			type: string;
			error: string | null;
		}>(
			`SELECT provider, provider_event_id, outcome, type, error FROM billing_event WHERE organization_id = $1 ORDER BY received_at, id`,
			[orgId],
		);

	const event = (orgId: string, type: BillingEvent["type"], overrides: Partial<BillingEvent> = {}): BillingEvent => ({
		type,
		provider: "fake",
		providerEventId: `evt-${run}-${++counter}`,
		orgId,
		planId: null,
		seats: null,
		interval: null,
		periodStart: null,
		periodEnd: null,
		amount: null,
		currency: null,
		...overrides,
	});
	const checkout = (orgId: string, overrides: Partial<BillingEvent> = {}) =>
		event(orgId, "checkout.completed", {
			planId: "starter",
			seats: 10,
			interval: "month",
			periodStart: NOW,
			periodEnd: at(30),
			amount: 4900,
			currency: "USD",
			providerCustomerId: "cus_1",
			providerSubscriptionId: "sub_1",
			...overrides,
		});
	const apply = (e: BillingEvent, now: Date = NOW) => inApp(() => billing.applyBillingEvent(e, now));
	const job = (now: Date) => inApp(() => billing.runBillingJobs({ now }));

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("billing_t04");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		for (const user of Object.values(ids))
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[user],
			);
		billing = await import("./index");
	}, 180_000);

	afterAll(async () => {
		await owner?.end();
		await app?.end();
		await database?.drop();
	});

	describe("billing_event and the app role", () => {
		it("gives careeros_app no privilege on the table and no way to read or write it directly", async () => {
			const orgId = await newOrg();
			await apply(checkout(orgId));
			const privilege = async (kind: string) =>
				(
					await ownerRows<{ ok: boolean }>(`SELECT has_table_privilege('careeros_app', 'billing_event', $1) AS ok`, [
						kind,
					])
				)[0]?.ok;
			for (const kind of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"])
				expect(await privilege(kind), kind).toBe(false);
			await expect(
				app.query(
					`INSERT INTO billing_event (provider, provider_event_id, type, outcome) VALUES ('fake', 'forged', 'payment.succeeded', 'applied')`,
				),
			).rejects.toMatchObject(denied);
			await expect(app.query(`UPDATE billing_event SET outcome = 'error'`)).rejects.toMatchObject(denied);
			await expect(app.query(`DELETE FROM billing_event`)).rejects.toMatchObject(denied);
			await expect(app.query(`SELECT * FROM billing_event`)).rejects.toMatchObject(denied);
			await expect(app.query(`TRUNCATE billing_event`)).rejects.toMatchObject(denied);
			expect(await events(orgId)).toHaveLength(1);
		});

		it("reaches the table only through careeros_record_billing_event, which validates its input", async () => {
			const record = (provider: string, id: string, type: string, outcome: string) =>
				app.query(`SELECT careeros_record_billing_event($1, $2, NULL, $3, $4, NULL) AS fresh`, [
					provider,
					id,
					type,
					outcome,
				]);
			expect((await record("fake", `direct-${run}`, "payment.succeeded", "applied")).rows[0]).toEqual({ fresh: true });
			expect((await record("fake", `direct-${run}`, "payment.succeeded", "applied")).rows[0]).toEqual({ fresh: false });
			// The same id from another provider is a different event.
			expect((await record("stripe", `direct-${run}`, "payment.succeeded", "applied")).rows[0]).toEqual({
				fresh: true,
			});
			await expect(record("fake", `direct2-${run}`, "payment.succeeded", "duplicate")).rejects.toThrow("outcome");
			await expect(record("FAKE", `direct3-${run}`, "payment.succeeded", "applied")).rejects.toThrow("provider");
			await expect(record("fake", "bad id", "payment.succeeded", "applied")).rejects.toThrow("provider event id");
			await expect(record("fake", `direct4-${run}`, "Bad Type", "applied")).rejects.toThrow("type");
		});

		it("is registered nowhere as a tenant table: rows are keyed by provider and event id", async () => {
			const [index] = await ownerRows<{ indexdef: string }>(
				`SELECT indexdef FROM pg_indexes WHERE tablename = 'billing_event' AND indexname = 'billing_event_provider_event_key'`,
			);
			expect(index?.indexdef).toContain("UNIQUE");
			expect(index?.indexdef).toContain("(provider, provider_event_id)");
			const [rls] = await ownerRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
				`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'billing_event'`,
			);
			expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
		});
	});

	describe("event intake", () => {
		it("applies a checkout: active, plan, seats, period, ids, grace cleared, audit with a null actor", async () => {
			const orgId = await newOrg(3);
			const result = await apply(checkout(orgId));
			expect(result).toEqual({ outcome: "applied", reason: null });
			expect(await state(orgId)).toMatchObject({
				status: "active",
				plan_id: "starter",
				sub_plan: "starter",
				sub_status: "active",
				provider: "fake",
				seats: 10,
				billing_interval: "month",
				grace_ends_at: null,
			});
			expect((await state(orgId)).current_period_end).toEqual(at(30));
			const rows = await ownerRows<{ action: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
				`SELECT action, actor_user_id, metadata FROM audit_log WHERE organization_id = $1`,
				[orgId],
			);
			expect(rows.map((row) => row.action).sort()).toEqual(
				["billing.checkout_completed", "org.plan_changed", "subscription.updated"].sort(),
			);
			expect(rows.every((row) => row.actor_user_id === null)).toBe(true);
			expect(rows.find((row) => row.action === "subscription.updated")?.metadata).toMatchObject({ source: "fake" });
			expect(await events(orgId)).toMatchObject([{ provider: "fake", type: "checkout.completed", outcome: "applied" }]);
		});

		it("a duplicate event is a no-op: no state change, no second audit row, no second record", async () => {
			const orgId = await newOrg();
			const e = checkout(orgId);
			await apply(e);
			const before = { state: await state(orgId), audit: await auditActions(orgId), events: await events(orgId) };
			const again = await apply(e, at(1));
			expect(again.outcome).toBe("duplicate");
			// The same id with different content is still a duplicate: the id decides.
			expect((await apply({ ...e, seats: 99 }, at(2))).outcome).toBe("duplicate");
			expect({ state: await state(orgId), audit: await auditActions(orgId), events: await events(orgId) }).toEqual(
				before,
			);
		});

		it("two copies of one event delivered at the same moment are applied once", async () => {
			const orgId = await newOrg();
			const e = checkout(orgId);
			const results = await Promise.all([apply(e), apply(e), apply(e)]);
			expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "duplicate", "duplicate"]);
			expect((await auditActions(orgId)).filter((a) => a === "billing.checkout_completed")).toHaveLength(1);
		});

		it("an older periodEnd never overwrites a newer one (out of order)", async () => {
			const orgId = await newOrg();
			await apply(checkout(orgId));
			await apply(event(orgId, "payment.succeeded", { periodStart: at(30), periodEnd: at(60), seats: 12 }), at(30));
			const stale = await apply(
				event(orgId, "payment.succeeded", { periodStart: NOW, periodEnd: at(30), seats: 3 }),
				at(31),
			);
			expect(stale).toEqual({ outcome: "ignored", reason: "stale_event" });
			expect(await state(orgId)).toMatchObject({ seats: 12 });
			expect((await state(orgId)).current_period_end).toEqual(at(60));
			expect((await events(orgId)).map((row) => row.outcome)).toEqual(["applied", "applied", "ignored"]);
		});

		it("takes the organization from the event's verified organization and leaves every other organization alone", async () => {
			const a = await newOrg();
			const b = await newOrg();
			const beforeB = { state: await state(b), audit: await auditActions(b) };
			await apply(checkout(a));
			expect(await state(a)).toMatchObject({ status: "active", plan_id: "starter" });
			expect({ state: await state(b), audit: await auditActions(b) }).toEqual(beforeB);
		});

		it("records an event for an organization that does not exist as ignored and changes nothing", async () => {
			const result = await apply(checkout(`bc-missing-${run}`));
			expect(result).toEqual({ outcome: "ignored", reason: "unknown_organization" });
			const rows = await ownerRows(`SELECT outcome, error FROM billing_event WHERE organization_id = $1`, [
				`bc-missing-${run}`,
			]);
			expect(rows).toEqual([{ outcome: "ignored", error: "unknown_organization" }]);
		});

		it("rolls everything back on a failure, leaves an error record, and a retry of the same event then succeeds", async () => {
			const orgId = await newOrg();
			const bad = checkout(orgId, { planId: "no-such-plan" });
			await expect(apply(bad)).rejects.toThrow("Unknown plan");
			expect(await state(orgId)).toMatchObject({ status: "active", plan_id: "personal", sub_status: "none" });
			expect(await auditActions(orgId)).toEqual([]);
			expect(await events(orgId)).toMatchObject([{ provider_event_id: bad.providerEventId, outcome: "error" }]);
			// The provider retries the same event; this time the plan is valid.
			const retried = await apply({ ...bad, planId: "starter" });
			expect(retried.outcome).toBe("applied");
			expect(await events(orgId)).toMatchObject([
				{ provider_event_id: bad.providerEventId, outcome: "applied", error: null },
			]);
			expect(await state(orgId)).toMatchObject({ status: "active", plan_id: "starter" });
		});

		it("keeps the members and records a warning when the provider sets fewer seats than there are members", async () => {
			const orgId = await newOrg(4);
			await apply(checkout(orgId, { seats: 10 }));
			await apply(event(orgId, "subscription.updated", { seats: 2 }), at(1));
			expect(await state(orgId)).toMatchObject({ seats: 2 });
			const [members] = await ownerRows<{ n: string }>(
				`SELECT count(*)::text AS n FROM member WHERE organization_id = $1`,
				[orgId],
			);
			expect(members?.n).toBe("4");
			const [warning] = await ownerRows<{ metadata: Record<string, unknown> }>(
				`SELECT metadata FROM audit_log WHERE organization_id = $1 AND action = 'billing.seats_below_members'`,
				[orgId],
			);
			expect(warning?.metadata).toMatchObject({ seatsPaid: 2, members: 4, membersKept: true });
		});

		it("walks the lifecycle: trial, subscribe, fail, past_due, suspended by the job, paid again", async () => {
			const orgId = await newOrg(2);
			await inApp(() => billing.startTrial(orgId, ids.ownerA, NOW));
			expect(await state(orgId)).toMatchObject({ status: "trial", plan_id: "trial", sub_status: "trialing", seats: 5 });
			await apply(checkout(orgId, { periodStart: at(2), periodEnd: at(32) }), at(2));
			expect(await state(orgId)).toMatchObject({ status: "active", plan_id: "starter" });
			await apply(event(orgId, "payment.failed"), at(32));
			const failed = await state(orgId);
			expect(failed).toMatchObject({ status: "past_due", sub_status: "past_due" });
			expect(failed.grace_ends_at).toEqual(at(39));
			// A second failure does not extend the grace period.
			await apply(event(orgId, "payment.failed"), at(34));
			expect((await state(orgId)).grace_ends_at).toEqual(at(39));
			expect((await job(at(38))).changed).toBe(0);
			expect((await state(orgId)).status).toBe("past_due");
			expect((await job(at(39))).changed).toBe(1);
			expect(await state(orgId)).toMatchObject({ status: "suspended" });
			await apply(event(orgId, "payment.succeeded", { periodStart: at(40), periodEnd: at(70) }), at(40));
			expect(await state(orgId)).toMatchObject({ status: "active", sub_status: "active", grace_ends_at: null });
			expect(await auditActions(orgId)).toEqual(
				expect.arrayContaining([
					"billing.trial_started",
					"billing.checkout_completed",
					"billing.payment_failed",
					"billing.grace_expired",
					"billing.payment_succeeded",
				]),
			);
		});
	});

	describe("trials", () => {
		it("starts once: 14 days, 5 seats, the trial plan; a second request changes nothing", async () => {
			const orgId = await newOrg();
			const first = await inApp(() => billing.startTrial(orgId, ids.ownerA, NOW));
			expect(first.applied).toBe(true);
			const s = await state(orgId);
			expect(s).toMatchObject({
				status: "trial",
				plan_id: "trial",
				sub_status: "trialing",
				seats: 5,
				provider: "none",
			});
			expect(s.trial_ends_at).toEqual(at(14));
			const before = await auditActions(orgId);
			const second = await inApp(() => billing.startTrial(orgId, ids.ownerA, at(1)));
			expect(second).toMatchObject({ applied: false });
			expect(await auditActions(orgId)).toEqual(before);
			const [row] = await ownerRows<{ actor_user_id: string | null }>(
				`SELECT actor_user_id FROM audit_log WHERE organization_id = $1 AND action = 'billing.trial_started'`,
				[orgId],
			);
			expect(row?.actor_user_id).toBe(ids.ownerA);
		});

		it("is refused after a trial that already ran its course", async () => {
			const orgId = await newOrg();
			await inApp(() => billing.startTrial(orgId, ids.ownerA, NOW));
			await job(at(15));
			expect((await state(orgId)).status).toBe("suspended");
			expect(await inApp(() => billing.startTrial(orgId, ids.ownerA, at(16)))).toMatchObject({ applied: false });
		});

		it("two requests at once start it once", async () => {
			const orgId = await newOrg();
			const results = await Promise.all([
				inApp(() => billing.startTrial(orgId, ids.ownerA, NOW)),
				inApp(() => billing.startTrial(orgId, ids.ownerA, NOW)),
			]);
			expect(results.filter((r) => r.applied)).toHaveLength(1);
			expect((await auditActions(orgId)).filter((a) => a === "billing.trial_started")).toHaveLength(1);
		});
	});

	describe("the periodic job", () => {
		it("suspends a trial that has ended, with audit rows, and only that one", async () => {
			const ended = await newOrg();
			const running = await newOrg();
			await inApp(() => billing.startTrial(ended, ids.ownerA, at(-20)));
			await inApp(() => billing.startTrial(running, ids.ownerA, NOW));
			const result = await job(NOW);
			expect(result.failed).toBe(0);
			expect(await state(ended)).toMatchObject({ status: "suspended", sub_status: "canceled" });
			expect((await state(running)).status).toBe("trial");
			expect(await auditActions(ended)).toEqual(
				expect.arrayContaining(["billing.trial_expired", "org.status_changed"]),
			);
		});

		it("ends a canceled subscription at its period end, not before", async () => {
			const orgId = await newOrg();
			await apply(checkout(orgId));
			await apply(event(orgId, "subscription.canceled", { periodEnd: at(30) }), at(1));
			expect(await state(orgId)).toMatchObject({ status: "active", sub_status: "canceled" });
			await job(at(29));
			expect((await state(orgId)).status).toBe("active");
			await job(at(30));
			expect((await state(orgId)).status).toBe("suspended");
			expect(await auditActions(orgId)).toContain("billing.subscription_ended");
		});

		it("is idempotent, and several instances at once change each organization once", async () => {
			const orgId = await newOrg();
			await inApp(() => billing.startTrial(orgId, ids.ownerA, at(-20)));
			const results = await Promise.all([job(NOW), job(NOW), job(NOW)]);
			expect(results.reduce((sum, r) => sum + r.changed, 0)).toBe(1);
			expect((await auditActions(orgId)).filter((a) => a === "billing.trial_expired")).toHaveLength(1);
			expect((await job(at(5))).changed).toBe(0);
		});

		it("leaves personal and healthy paying organizations alone, however late it runs", async () => {
			const personal = await newOrg();
			const paying = await newOrg();
			await apply(checkout(paying));
			await job(at(10));
			expect((await state(personal)).status).toBe("active");
			expect((await state(paying)).status).toBe("active");
		});

		it("uses the database clock when no time is given", async () => {
			const orgId = await newOrg();
			await inApp(() => billing.startTrial(orgId, ids.ownerA, new Date(Date.now() - 20 * DAY)));
			const result = await inApp(() => billing.runBillingJobs());
			expect(result.changed).toBeGreaterThanOrEqual(1);
			expect((await state(orgId)).status).toBe("suspended");
		});
	});

	describe("manual payments", () => {
		const payment = (orgId: string, overrides: Partial<import("./manual-payment").ManualPaymentInput> = {}) => ({
			orgId,
			planId: "pro",
			seats: 25,
			interval: "year" as const,
			periodStart: NOW,
			periodEnd: at(365),
			amount: 3_600_000,
			currency: "KES",
			reference: `INV-${run}-${++counter}`,
			actorUserId: ids.admin,
			...overrides,
		});

		it("applies the same transition as payment.succeeded, with provider manual, and writes audit rows", async () => {
			const orgId = await newOrg(2);
			const p = payment(orgId);
			expect(await inApp(() => billing.recordManualPayment(p))).toBe(true);
			expect(await state(orgId)).toMatchObject({
				status: "active",
				plan_id: "pro",
				sub_plan: "pro",
				sub_status: "active",
				provider: "manual",
				seats: 25,
				billing_interval: "year",
				grace_ends_at: null,
			});
			expect((await state(orgId)).current_period_end).toEqual(at(365));
			const rows = await ownerRows<{ action: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
				`SELECT action, actor_user_id, metadata FROM audit_log WHERE organization_id = $1`,
				[orgId],
			);
			expect(rows.map((r) => r.action)).toEqual(
				expect.arrayContaining(["billing.manual_payment", "org.plan_changed", "subscription.updated"]),
			);
			expect(rows.find((r) => r.action === "billing.manual_payment")).toMatchObject({
				actor_user_id: ids.admin,
				metadata: { reference: p.reference, amount: 3_600_000, currency: "KES", source: "manual" },
			});
			expect(await events(orgId)).toMatchObject([
				{ provider: "manual", provider_event_id: `manual:${orgId}:${p.reference}`, outcome: "applied" },
			]);
		});

		it("leaves the same subscription as the machine does for an equal payment.succeeded event", async () => {
			const viaMachine = await newOrg(2);
			const viaManual = await newOrg(2);
			await apply(
				event(viaMachine, "payment.succeeded", {
					planId: "pro",
					seats: 25,
					interval: "year",
					periodStart: NOW,
					periodEnd: at(365),
				}),
			);
			await inApp(() => billing.recordManualPayment(payment(viaManual)));
			const pick = (s: Awaited<ReturnType<typeof state>>) => ({
				status: s.status,
				plan_id: s.plan_id,
				sub_status: s.sub_status,
				seats: s.seats,
				billing_interval: s.billing_interval,
				current_period_start: s.current_period_start,
				current_period_end: s.current_period_end,
				grace_ends_at: s.grace_ends_at,
			});
			expect(pick(await state(viaManual))).toEqual(pick(await state(viaMachine)));
			// And from a past-due state, the machine and the function both clear the grace period.
			const late = await newOrg();
			await apply(checkout(late));
			await apply(event(late, "payment.failed"), at(31));
			expect((await state(late)).grace_ends_at).not.toBeNull();
			await inApp(() =>
				billing.recordManualPayment(
					payment(late, { periodStart: at(31), periodEnd: at(61), interval: "month", planId: "starter", seats: 10 }),
				),
			);
			expect(await state(late)).toMatchObject({
				status: "active",
				sub_status: "active",
				grace_ends_at: null,
				provider: "manual",
			});
		});

		it("applies a reference once for an organization", async () => {
			const orgId = await newOrg();
			const p = payment(orgId);
			expect(await inApp(() => billing.recordManualPayment(p))).toBe(true);
			const audit = await auditActions(orgId);
			expect(await inApp(() => billing.recordManualPayment({ ...p, seats: 99 }))).toBe(false);
			expect(await auditActions(orgId)).toEqual(audit);
			expect(await state(orgId)).toMatchObject({ seats: 25 });
		});

		it("revives a suspended organization and refuses a period older than the one held", async () => {
			const orgId = await newOrg();
			await inApp(() => billing.startTrial(orgId, ids.ownerA, at(-20)));
			await job(NOW);
			expect((await state(orgId)).status).toBe("suspended");
			await inApp(() =>
				billing.recordManualPayment(
					payment(orgId, { periodStart: NOW, periodEnd: at(30), planId: "starter", seats: 5, interval: "month" }),
				),
			);
			expect((await state(orgId)).status).toBe("active");
			await expect(
				inApp(() => billing.recordManualPayment(payment(orgId, { periodStart: at(-60), periodEnd: at(-30) }))),
			).rejects.toThrow("before the paid period");
		});

		it("records a warning when the seats are below the members, and rejects malformed input", async () => {
			const orgId = await newOrg(3);
			await inApp(() => billing.recordManualPayment(payment(orgId, { seats: 2 })));
			expect(await auditActions(orgId)).toContain("billing.seats_below_members");
			for (const bad of [
				payment(orgId, { seats: 0 }),
				payment(orgId, { amount: -1 }),
				payment(orgId, { periodEnd: NOW }),
				payment(orgId, { currency: "usd" }),
				payment(orgId, { reference: "" }),
				payment(orgId, { planId: "nope" }),
				payment(`bc-missing-${run}`),
				payment(orgId, { actorUserId: `bc-nobody-${run}` }),
			])
				await expect(inApp(() => billing.recordManualPayment(bad))).rejects.toThrow();
		});

		it("may be called by the app role, which is why the platform-admin check lives in P3-T07", async () => {
			const orgId = await newOrg();
			const { rows } = await app.query(
				`SELECT careeros_record_manual_payment($1, 'starter', 3, 'month', now(), now() + interval '30 days', 100, 'USD', $2, $3) AS applied`,
				[orgId, `direct-${run}`, ids.admin],
			);
			expect(rows[0]).toEqual({ applied: true });
		});
	});
});
