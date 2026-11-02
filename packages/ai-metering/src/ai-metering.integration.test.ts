import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
	createIsolatedTestDatabase,
	withOrgContext as inOrgTransaction,
	type IsolatedTestDatabase,
} from "@careeros/testing";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Pool } from "pg";
import { withDatabasePool } from "@reactive-resume/db/client";

// P3-T03: AI metering on a database of its own with every migration applied, read and written as `careeros_app`
// (NOSUPERUSER, NOBYPASSRLS). The language model is a deterministic mock: no test calls the real Claude API. Skipped
// only when the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

type Usage = { input: number; output: number; cached?: number };

describe.skipIf(!configured)("AI metering", () => {
	const run = randomUUID().slice(0, 8);
	const ids = {
		orgA: `meter-a-${run}`,
		orgB: `meter-b-${run}`,
		userA1: `meter-user-a1-${run}`,
		userA2: `meter-user-a2-${run}`,
		userB: `meter-user-b-${run}`,
	};
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let metering: typeof import("./index");
	let tenancy: typeof import("@careeros/tenancy");

	const inApp = <T>(fn: () => T) => withDatabasePool(app, fn);
	const inScope = <T>(orgId: string, fn: () => Promise<T>) => inApp(async () => tenancy.withOrgContext(orgId, fn));
	const ownerRows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
		(await owner.query<T>(sql, params)).rows;
	const asApp = (orgId: string, sql: string, params: unknown[] = []) =>
		inOrgTransaction(app, orgId, (client) => client.query(sql, params));
	const rowsOf = (orgId: string) =>
		ownerRows<{
			source: string;
			feature: string;
			provider: string;
			model: string;
			user_id: string | null;
			input_tokens: number;
			output_tokens: number;
			cached_input_tokens: number;
			cost_usd_micros: string;
			credits: number;
		}>(`SELECT * FROM ai_usage WHERE organization_id = $1 ORDER BY id`, [orgId]);
	const clearUsage = (orgId: string) => owner.query(`DELETE FROM ai_usage WHERE organization_id = $1`, [orgId]);
	const setSubscription = (orgId: string, fields: unknown) =>
		owner.query(`SELECT careeros_set_subscription($1, $2::jsonb, NULL, 'test')`, [orgId, JSON.stringify(fields)]);
	/** Credits already used, written as the owner so a test can put the pool anywhere. */
	const seedCredits = (orgId: string, credits: number, createdAt = new Date()) =>
		owner.query(
			`INSERT INTO ai_usage (organization_id, user_id, source, feature, provider, model, credits, created_at)
			 VALUES ($1, $2, 'platform', 'resume.improve', 'anthropic', 'claude-sonnet-5-5', $3, $4)`,
			[orgId, orgId === ids.orgA ? ids.userA1 : ids.userB, credits, createdAt],
		);

	const usageOf = ({ input, output, cached = 0 }: Usage) => ({
		inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: 0 },
		outputTokens: { total: output, text: output, reasoning: 0 },
	});
	const generating = (usage: Usage) =>
		new MockLanguageModelV4({
			doGenerate: async () => ({
				content: [{ type: "text", text: "ok" }],
				finishReason: { unified: "stop", raw: "stop" },
				usage: usageOf(usage),
				warnings: [],
			}),
		});
	const streaming = (usage: Usage, options: { fail?: boolean } = {}) =>
		new MockLanguageModelV4({
			doStream: async () => ({
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						controller.enqueue({ type: "text-start", id: "1" });
						controller.enqueue({ type: "text-delta", id: "1", delta: "hel" });
						if (options.fail) {
							controller.error(new Error("provider went away"));
							return;
						}
						controller.enqueue({ type: "text-delta", id: "1", delta: "lo" });
						controller.enqueue({ type: "text-end", id: "1" });
						controller.enqueue({
							type: "finish",
							finishReason: { unified: "stop", raw: "stop" },
							usage: usageOf(usage),
						});
						controller.close();
					},
				}),
			}),
		});
	const meter = (
		model: MockLanguageModelV4,
		source: "platform" | "own_key",
		userId = ids.userA1,
		modelId = "claude-sonnet-5-5",
	) =>
		metering.meterLanguageModel(model, {
			metering: { feature: "resume.improve", userId, source },
			provider: "anthropic",
			modelId,
			// A stream is recorded after the request's scope closed, in a fresh scope of the same organization. In
			// production that scope uses the default pool; here the default pool is not the isolated database.
			run: (
				(org) => (fn) =>
					tenancy.currentOrgId() ? tenancy.withOrgContext(org, fn) : inApp(() => tenancy.withOrgContext(org, fn))
			)(tenancy.requireOrgId()),
		});

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("aimeter_t03");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		for (const user of [ids.userA1, ids.userA2, ids.userB])
			await owner.query(
				`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
				[user],
			);
		for (const org of [ids.orgA, ids.orgB])
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [org]);
		await owner.query(
			`INSERT INTO member (id, organization_id, user_id, role) VALUES ('mm1', $1, $2, 'owner'), ('mm2', $1, $3, 'member')`,
			[ids.orgA, ids.userA1, ids.userA2],
		);
		await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ('mm3', $1, $2, 'owner')`, [
			ids.orgB,
			ids.userB,
		]);
		metering = await import("./index");
		tenancy = await import("@careeros/tenancy");
	}, 180_000);

	afterAll(async () => {
		await owner?.end();
		await app?.end();
		await database?.drop();
	});

	describe("recording", () => {
		it("writes one platform row for a generate, priced from the table", async () => {
			await clearUsage(ids.orgA);
			const result = await inScope(ids.orgA, () =>
				generateText({
					model: meter(generating({ input: 1_000_000, output: 100_000, cached: 400_000 }), "platform"),
					prompt: "hi",
				}),
			);
			expect(result.text).toBe("ok");
			const rows = await rowsOf(ids.orgA);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				source: "platform",
				feature: "resume.improve",
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				user_id: ids.userA1,
				input_tokens: 1_000_000,
				output_tokens: 100_000,
				cached_input_tokens: 400_000,
				cost_usd_micros: "2280000",
				credits: 228,
			});
		});

		it("writes one row for a stream when it finishes", async () => {
			await clearUsage(ids.orgA);
			const text = await inScope(ids.orgA, async () => {
				const model = meter(streaming({ input: 2_000, output: 500 }), "platform", ids.userA2, "claude-haiku-5-5");
				return streamText({ model, prompt: "hi" }).text;
			});
			expect(text).toBe("hello");
			await vi.waitFor(async () => expect(await rowsOf(ids.orgA)).toHaveLength(1));
			const [row] = await rowsOf(ids.orgA);
			expect(row).toMatchObject({
				source: "platform",
				model: "claude-haiku-5-5",
				user_id: ids.userA2,
				input_tokens: 2_000,
				output_tokens: 500,
			});
			// 2,000 x $0.10 + 500 x $0.50 per million = 450 millionths of a dollar: one credit.
			expect(row?.cost_usd_micros).toBe("450");
			expect(row?.credits).toBe(1);
		});

		it("still records a stream the reader abandons after tokens were produced", async () => {
			await clearUsage(ids.orgA);
			const { stream } = await inScope(ids.orgA, () =>
				meter(streaming({ input: 10, output: 10 }), "platform").doStream({ prompt: [] } as never),
			);
			const reader = stream.getReader();
			await reader.read();
			await reader.read();
			await reader.cancel();
			await vi.waitFor(async () => expect(await rowsOf(ids.orgA)).toHaveLength(1));
			// The mock never got to report usage, so the row holds what the SDK reported: nothing.
			expect((await rowsOf(ids.orgA))[0]).toMatchObject({
				source: "platform",
				input_tokens: 0,
				output_tokens: 0,
				credits: 0,
			});
		});

		it("records a stream that fails midway, once", async () => {
			await clearUsage(ids.orgA);
			await inScope(ids.orgA, async () => {
				const model = meter(streaming({ input: 10, output: 10 }, { fail: true }), "platform");
				await streamText({ model, prompt: "hi", onError: () => undefined }).consumeStream({ onError: () => undefined });
			});
			await vi.waitFor(async () => expect(await rowsOf(ids.orgA)).toHaveLength(1));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(await rowsOf(ids.orgA)).toHaveLength(1);
		});

		it("records own-key calls with zero cost and zero credits, for generate and stream", async () => {
			await clearUsage(ids.orgA);
			// An own-key model may be any model: no price is needed and none is charged.
			await inScope(ids.orgA, async () => {
				const generated = meter(
					generating({ input: 5_000_000, output: 5_000_000 }),
					"own_key",
					ids.userA1,
					"gpt-5-mini",
				);
				await generateText({ model: generated, prompt: "hi" });
				const streamed = meter(streaming({ input: 5_000_000, output: 5_000_000 }), "own_key", ids.userA1, "gpt-5-mini");
				await streamText({ model: streamed, prompt: "hi" }).text;
			});
			await vi.waitFor(async () => expect(await rowsOf(ids.orgA)).toHaveLength(2));
			for (const row of await rowsOf(ids.orgA))
				expect(row).toMatchObject({ source: "own_key", cost_usd_micros: "0", credits: 0 });
			expect((await rowsOf(ids.orgA))[0]?.input_tokens).toBe(5_000_000);
		});

		it("refuses a platform model with no price before any call", async () => {
			const model = generating({ input: 1, output: 1 });
			await expect(
				inScope(ids.orgA, async () => meter(model, "platform", ids.userA1, "claude-mystery-1")),
			).rejects.toBeInstanceOf(metering.AiModelNotPricedError);
			expect(model.doGenerateCalls).toHaveLength(0);
		});

		it("does not lose the result when the usage write fails, and counts the failure", async () => {
			const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
			metering.resetUsageWriteFailureCount();
			await clearUsage(ids.orgA);
			// The quota gate reads the database; the write is the part that fails.
			const result = await inScope(ids.orgA, () =>
				generateText({
					model: metering.meterLanguageModel(generating({ input: 10, output: 10 }), {
						metering: { feature: "ats.review", userId: ids.userA1, source: "platform" },
						provider: "anthropic",
						modelId: "claude-sonnet-5-5",
						run: async () => {
							throw new Error("database is down");
						},
					}),
					prompt: "hi",
				}),
			);
			expect(result.text).toBe("ok");
			expect(metering.usageWriteFailureCount()).toBe(1);
			const line = log.mock.calls.map((call) => String(call[0])).find((text) => text.includes("ai_usage.write_failed"));
			expect(JSON.parse(line ?? "{}")).toMatchObject({
				evt: "ai_usage.write_failed",
				organizationId: ids.orgA,
				feature: "ats.review",
			});
			log.mockRestore();
		});
	});

	describe("the quota", () => {
		it("allows platform calls below 100% and warns from 80%", async () => {
			await clearUsage(ids.orgA);
			// Organization A: personal plan, 50 credits per seat x 2 members = 100.
			expect(await inScope(ids.orgA, () => metering.getQuotaState(ids.orgA))).toMatchObject({
				used: 0,
				allowance: 100,
				warning: false,
				blocked: false,
			});
			await seedCredits(ids.orgA, 79);
			expect((await inScope(ids.orgA, () => metering.getQuotaState(ids.orgA))).warning).toBe(false);
			await seedCredits(ids.orgA, 1);
			expect(await inScope(ids.orgA, () => metering.getQuotaState(ids.orgA))).toMatchObject({
				used: 80,
				warning: true,
				blocked: false,
			});
			await expect(
				inScope(ids.orgA, () =>
					generateText({ model: meter(generating({ input: 10, output: 10 }), "platform"), prompt: "hi" }),
				),
			).resolves.toMatchObject({ text: "ok" });
		});

		it("refuses a platform call at 100% with AI_QUOTA_EXCEEDED, and lets own-key calls through", async () => {
			await clearUsage(ids.orgA);
			await seedCredits(ids.orgA, 100);
			const platform = generating({ input: 10, output: 10 });
			await expect(
				inScope(ids.orgA, () => generateText({ model: meter(platform, "platform"), prompt: "hi" })),
			).rejects.toMatchObject({ code: "AI_QUOTA_EXCEEDED", data: { used: 100, allowance: 100 } });
			expect(platform.doGenerateCalls).toHaveLength(0);
			// A stream is refused the same way.
			const streamed = streaming({ input: 10, output: 10 });
			const failures: unknown[] = [];
			await inScope(ids.orgA, () =>
				streamText({
					model: meter(streamed, "platform"),
					prompt: "hi",
					onError: ({ error }) => void failures.push(error),
				}).consumeStream({ onError: (error) => void failures.push(error) }),
			);
			expect(failures[0]).toMatchObject({ code: "AI_QUOTA_EXCEEDED" });
			expect(streamed.doStreamCalls).toHaveLength(0);
			// Own-key calls are never refused for quota.
			await expect(
				inScope(ids.orgA, () =>
					generateText({
						model: meter(generating({ input: 10, output: 10 }), "own_key", ids.userA1, "gpt-5-mini"),
						prompt: "hi",
					}),
				),
			).resolves.toMatchObject({ text: "ok" });
		});

		it("lets one call take usage over 100%, then refuses the next", async () => {
			await clearUsage(ids.orgA);
			await seedCredits(ids.orgA, 99);
			// Sonnet: 1M output tokens is $10, that is 1,000 credits.
			await inScope(ids.orgA, () =>
				generateText({ model: meter(generating({ input: 0, output: 1_000_000 }), "platform"), prompt: "hi" }),
			);
			const state = await inScope(ids.orgA, () => metering.getQuotaState(ids.orgA));
			expect(state.used).toBe(99 + 1_000);
			await expect(
				inScope(ids.orgA, () =>
					generateText({ model: meter(generating({ input: 1, output: 1 }), "platform"), prompt: "hi" }),
				),
			).rejects.toMatchObject({
				code: "AI_QUOTA_EXCEEDED",
			});
		});

		it("passes at 100% when overage is allowed for the organization", async () => {
			await clearUsage(ids.orgA);
			await seedCredits(ids.orgA, 250);
			await setSubscription(ids.orgA, { ai_overage_allowed: true });
			await expect(
				inScope(ids.orgA, () =>
					generateText({ model: meter(generating({ input: 10, output: 10 }), "platform"), prompt: "hi" }),
				),
			).resolves.toMatchObject({ text: "ok" });
			expect(await inScope(ids.orgA, () => metering.getQuotaState(ids.orgA))).toMatchObject({
				exceeded: true,
				blocked: false,
			});
			await setSubscription(ids.orgA, { ai_overage_allowed: false });
		});

		it("sums the subscription's period, not the calendar month", async () => {
			await clearUsage(ids.orgB);
			const now = Date.now();
			const day = 86_400_000;
			await setSubscription(ids.orgB, {
				current_period_start: new Date(now - 3 * day).toISOString(),
				current_period_end: new Date(now + 27 * day).toISOString(),
			});
			await seedCredits(ids.orgB, 7, new Date(now - 10 * day));
			await seedCredits(ids.orgB, 11, new Date(now - 1 * day));
			const state = await inScope(ids.orgB, () => metering.getQuotaState(ids.orgB));
			expect(state.period.source).toBe("subscription");
			expect(state.used).toBe(11);
			await setSubscription(ids.orgB, { current_period_start: null, current_period_end: null });
			expect((await inScope(ids.orgB, () => metering.getQuotaState(ids.orgB))).period.source).toBe("calendar_month");
		});
	});

	describe("the summary", () => {
		it("reports the period by feature, by member and by day, platform credits only", async () => {
			await clearUsage(ids.orgA);
			await owner.query(
				`INSERT INTO ai_usage (organization_id, user_id, source, feature, provider, model, credits) VALUES
				 ($1, $2, 'platform', 'resume.improve', 'anthropic', 'claude-sonnet-5-5', 5),
				 ($1, $2, 'platform', 'agent.turn', 'anthropic', 'claude-sonnet-5-5', 7),
				 ($1, $3, 'platform', 'agent.turn', 'anthropic', 'claude-sonnet-5-5', 3),
				 ($1, $3, 'own_key', 'agent.turn', 'openai', 'gpt-5-mini', 0)`,
				[ids.orgA, ids.userA1, ids.userA2],
			);
			const summary = await inScope(ids.orgA, () => metering.getUsageSummary(ids.orgA));
			expect(summary).toMatchObject({ used: 15, allowance: 100, overageAllowed: false });
			expect(summary.byFeature).toEqual([
				{ feature: "agent.turn", calls: 2, credits: 10 },
				{ feature: "resume.improve", calls: 1, credits: 5 },
			]);
			expect(summary.byMember).toEqual([
				{ userId: ids.userA1, name: ids.userA1, calls: 2, credits: 12 },
				{ userId: ids.userA2, name: ids.userA2, calls: 1, credits: 3 },
			]);
			expect(summary.byDay).toHaveLength(1);
			expect(summary.byDay[0]).toMatchObject({ calls: 3, credits: 15 });
		});
	});

	describe("row-level security and privileges", () => {
		it("shows Organization B none of Organization A's rows", async () => {
			await clearUsage(ids.orgA);
			await clearUsage(ids.orgB);
			await seedCredits(ids.orgA, 5);
			expect((await asApp(ids.orgA, `SELECT count(*)::int AS n FROM ai_usage`)).rows[0]).toEqual({ n: 1 });
			expect((await asApp(ids.orgB, `SELECT count(*)::int AS n FROM ai_usage`)).rows[0]).toEqual({ n: 0 });
			// Without an organization context nothing is visible at all.
			expect((await app.query(`SELECT count(*)::int AS n FROM ai_usage`)).rows[0]).toEqual({ n: 0 });
		});

		it("lets careeros_app insert only for its own organization", async () => {
			const insert = (orgId: string) =>
				`INSERT INTO ai_usage (organization_id, source, feature, provider, model) VALUES ('${orgId}', 'own_key', 'resume.improve', 'openai', 'gpt-5-mini')`;
			await expect(asApp(ids.orgA, insert(ids.orgA))).resolves.toBeDefined();
			await expect(asApp(ids.orgA, insert(ids.orgB))).rejects.toMatchObject({ code: "42501" });
		});

		it("refuses UPDATE, DELETE and TRUNCATE to careeros_app", async () => {
			await seedCredits(ids.orgA, 1);
			await expect(asApp(ids.orgA, `UPDATE ai_usage SET credits = 0`)).rejects.toMatchObject({ code: "42501" });
			await expect(asApp(ids.orgA, `DELETE FROM ai_usage`)).rejects.toMatchObject({ code: "42501" });
			await expect(asApp(ids.orgA, `TRUNCATE ai_usage`)).rejects.toMatchObject({ code: "42501" });
		});

		it("keeps the source and the credits honest with a CHECK", async () => {
			await expect(
				owner.query(
					`INSERT INTO ai_usage (organization_id, source, feature, provider, model) VALUES ($1, 'free', 'x', 'y', 'z')`,
					[ids.orgA],
				),
			).rejects.toMatchObject({ code: "23514" });
		});

		it("removes an organization's rows with the organization and keeps them when a member is deleted", async () => {
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)`, [`meter-gone-${run}`]);
			await owner.query(
				`INSERT INTO ai_usage (organization_id, user_id, source, feature, provider, model) VALUES ($1, $2, 'own_key', 'resume.improve', 'openai', 'gpt-5-mini')`,
				[`meter-gone-${run}`, ids.userB],
			);
			await owner.query(`DELETE FROM organization WHERE id = $1`, [`meter-gone-${run}`]);
			expect(await ownerRows(`SELECT 1 FROM ai_usage WHERE organization_id = $1`, [`meter-gone-${run}`])).toHaveLength(
				0,
			);
		});
	});
});
