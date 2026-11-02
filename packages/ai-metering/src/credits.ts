import { priceFor } from "./prices";

// CAREEROS (P3-T03, phase plan D5): the credit maths. 1 credit = USD 0.01 of platform cost, rounded up per call.

/** One credit is one US cent, that is 10,000 millionths of a dollar. */
export const MICRO_USD_PER_CREDIT = 10_000;

/** Token counts of one call. `inputTokens` is the total prompt size; `cachedInputTokens` is the part read from cache. */
export type TokenUsage = { inputTokens: number; outputTokens: number; cachedInputTokens: number };

export type CallCost = { costUsdMicros: number; credits: number };

/** The rule, in one place: credits for a cost in millionths of a dollar. Any positive cost is at least one credit. */
export function creditsForCostMicros(costUsdMicros: number): number {
	if (!Number.isFinite(costUsdMicros) || costUsdMicros <= 0) return 0;
	return Math.ceil(costUsdMicros / MICRO_USD_PER_CREDIT);
}

const nonNegativeInt = (value: number) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/**
 * Cost of one call on the platform key, in millionths of a dollar, and the credits it takes. Throws
 * `AiModelNotPricedError` for a model without a price.
 */
export function costOfCall(model: string, usage: TokenUsage): CallCost {
	const price = priceFor(model);
	const inputTokens = nonNegativeInt(usage.inputTokens);
	const outputTokens = nonNegativeInt(usage.outputTokens);
	const cachedInputTokens = Math.min(nonNegativeInt(usage.cachedInputTokens), inputTokens);
	const rates = price.longPrompt && inputTokens > price.longPrompt.aboveInputTokens ? price.longPrompt : price;

	// 1 USD per million tokens is exactly 1 millionth of a dollar per token. Prices are held in thousandths of that so
	// the sum is an exact integer; the only rounding is the final round up to a whole millionth.
	const milli = (usdPerMTok: number) => Math.round(usdPerMTok * 1000);
	const thousandths =
		(inputTokens - cachedInputTokens) * milli(rates.input) +
		cachedInputTokens * milli(rates.cachedInput) +
		outputTokens * milli(rates.output);
	const costUsdMicros = Math.ceil(thousandths / 1000);
	return { costUsdMicros, credits: creditsForCostMicros(costUsdMicros) };
}
