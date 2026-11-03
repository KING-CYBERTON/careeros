// CAREEROS (P3-T03, phase plan D5): the one price table. USD per million tokens, per model id, for the platform key.
//
// Source: the Claude API model list and pricing reference (claude-api skill, "Current Models", cached 2026-10-06) and
// https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-02.
//   claude-sonnet-5-5  input $2.00, output $10.00, cache reads $0.20 per million tokens.
//   claude-haiku-5-5   input $0.10, output $0.50 per million tokens for prompts of 100K tokens or fewer, and
//                      $0.50 / $2.50 above that. The reference lists no cache-read price for this model; the 10% of
//                      the input price that every other current model uses is assumed (Q201).
// Cache writes are charged at the input price (the spec's table has input, output and cached only; see Q201).
//
// An unknown model has no entry and is refused (`AiModelNotPricedError`): the platform key never records a call at zero.

/** Prices in USD per million tokens. */
type PriceRates = { input: number; output: number; cachedInput: number };

export type ModelPrice = PriceRates & {
	/** Prices for a prompt longer than `aboveInputTokens`. */
	longPrompt?: PriceRates & { aboveInputTokens: number };
};

export const PRICES_USD_PER_MTOK: Readonly<Record<string, ModelPrice>> = {
	"claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.2 },
	"claude-haiku-5-5": {
		input: 0.1,
		output: 0.5,
		cachedInput: 0.01,
		longPrompt: { aboveInputTokens: 100_000, input: 0.5, output: 2.5, cachedInput: 0.05 },
	},
};

export class AiModelNotPricedError extends Error {
	readonly code = "AI_MODEL_NOT_PRICED";
	constructor(readonly model: string) {
		super(`The model "${model}" has no price in the AI price table, so it can't be used with the platform key.`);
		this.name = "AiModelNotPricedError";
	}
}

/** The price entry for a model id. Throws for an unknown model: the call is refused, never recorded at zero. */
export function priceFor(model: string): ModelPrice {
	const price = Object.hasOwn(PRICES_USD_PER_MTOK, model) ? PRICES_USD_PER_MTOK[model] : undefined;
	if (!price) throw new AiModelNotPricedError(model);
	return price;
}
