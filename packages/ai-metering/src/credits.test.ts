import { describe, expect, it } from "vite-plus/test";
import { costOfCall, creditsForCostMicros, MICRO_USD_PER_CREDIT } from "./credits";
import { AiModelNotPricedError, priceFor, PRICES_USD_PER_MTOK } from "./prices";

describe("credits", () => {
	it("is 1 credit per USD 0.01 and rounds every positive cost up", () => {
		expect(MICRO_USD_PER_CREDIT).toBe(10_000);
		expect(creditsForCostMicros(0)).toBe(0);
		expect(creditsForCostMicros(-5)).toBe(0);
		expect(creditsForCostMicros(Number.NaN)).toBe(0);
		expect(creditsForCostMicros(1)).toBe(1);
		expect(creditsForCostMicros(9_999)).toBe(1);
		expect(creditsForCostMicros(10_000)).toBe(1);
		expect(creditsForCostMicros(10_001)).toBe(2);
		expect(creditsForCostMicros(250_000)).toBe(25);
	});

	it("rounds up per call, not in total", () => {
		const one = costOfCall("claude-haiku-5-5", { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 });
		// A tiny call is still a whole credit; three of them are three credits, not one.
		expect(one.credits).toBe(1);
		expect(one.credits * 3).toBe(3);
	});

	it("prices input, output and cached input separately", () => {
		// Sonnet 5.5: $2 in, $10 out, $0.20 cached per million tokens. 1M input of which 400K cached, 100K output:
		// 600K x $2 + 400K x $0.20 + 100K x $10 = $1.20 + $0.08 + $1.00 = $2.28 = 2,280,000 micros = 228 credits.
		const cost = costOfCall("claude-sonnet-5-5", {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cachedInputTokens: 400_000,
		});
		expect(cost).toEqual({ costUsdMicros: 2_280_000, credits: 228 });
	});

	it("uses the long-prompt prices of the fast model above 100K input tokens", () => {
		const short = costOfCall("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 0, cachedInputTokens: 0 });
		const long = costOfCall("claude-haiku-5-5", { inputTokens: 100_001, outputTokens: 0, cachedInputTokens: 0 });
		expect(short.costUsdMicros).toBe(10_000);
		expect(long.costUsdMicros).toBe(50_001);
	});

	it("never charges negative, fractional or impossible token counts", () => {
		const cost = costOfCall("claude-sonnet-5-5", { inputTokens: -5, outputTokens: 1.9, cachedInputTokens: 99 });
		expect(cost.costUsdMicros).toBe(10);
		// Cached tokens are part of the input and can never exceed it.
		expect(
			costOfCall("claude-sonnet-5-5", { inputTokens: 10, outputTokens: 0, cachedInputTokens: 99 }).costUsdMicros,
		).toBe(2);
	});

	it("keeps exact integer micros (no float drift)", () => {
		expect(
			costOfCall("claude-haiku-5-5", { inputTokens: 3, outputTokens: 0, cachedInputTokens: 0 }).costUsdMicros,
		).toBe(1);
		expect(
			costOfCall("claude-haiku-5-5", { inputTokens: 10, outputTokens: 0, cachedInputTokens: 0 }).costUsdMicros,
		).toBe(1);
		expect(
			costOfCall("claude-haiku-5-5", { inputTokens: 20, outputTokens: 0, cachedInputTokens: 0 }).costUsdMicros,
		).toBe(2);
	});
});

describe("the price table", () => {
	it("has the two default platform models", () => {
		expect(Object.keys(PRICES_USD_PER_MTOK).sort()).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
		expect(priceFor("claude-sonnet-5-5")).toMatchObject({ input: 2, output: 10, cachedInput: 0.2 });
	});

	it("fails closed for an unknown model", () => {
		expect(() => priceFor("claude-unknown-9")).toThrow(AiModelNotPricedError);
		expect(() => costOfCall("gpt-5", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 })).toThrow(
			AiModelNotPricedError,
		);
		// Prototype keys are not models.
		expect(() => priceFor("constructor")).toThrow(AiModelNotPricedError);
		expect(() => priceFor("toString")).toThrow(AiModelNotPricedError);
	});
});
