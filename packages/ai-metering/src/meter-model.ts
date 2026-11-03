import type { TokenUsage } from "./credits";
import type { AiFeature } from "./features";
import type { LanguageModelMiddleware } from "ai";
import { captureOrgScope, requireOrgId } from "@careeros/tenancy";
import { wrapLanguageModel } from "ai";
import { priceFor } from "./prices";
import { assertWithinQuota } from "./quota";
import { recordUsage, type RunInOrg, type UsageSource } from "./recorder";

// CAREEROS (P3-T03, phase plan D5): the metered language model. `meterLanguageModel` wraps a model with AI SDK
// middleware that records one `ai_usage` row after every generate and every stream. It is the only way a call reaches
// the platform key, so a call that is not metered cannot be made with it.

export type Metering = {
	feature: AiFeature;
	/** The member making the call; null for system work with no member. */
	userId: string | null;
	source: UsageSource;
};

type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>;
type StreamResult = Awaited<ReturnType<WrapStream>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type ReportedUsage = Extract<StreamPart, { type: "finish" }>["usage"];

const count = (value: number | undefined) =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Token counts from whatever usage shape the SDK reports. Missing numbers count as zero. */
export function tokenUsageOf(usage: ReportedUsage | undefined): TokenUsage {
	if (!usage) return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
	const input = usage.inputTokens;
	const output = usage.outputTokens;
	// The V4 usage keeps the totals and the split. Some providers report only the split.
	const inputTokens = count(input.total) || count(input.noCache) + count(input.cacheRead) + count(input.cacheWrite);
	const outputTokens = count(output.total) || count(output.text) + count(output.reasoning);
	const cachedInputTokens = Math.min(count(input.cacheRead), inputTokens);
	const cacheWriteTokens = Math.min(count(input.cacheWrite), inputTokens - cachedInputTokens);
	return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens };
}

export type MeterOptions = {
	metering: Metering;
	/** The provider name written to `ai_usage.provider`. */
	provider: string;
	/** The model id written to `ai_usage.model`, and priced on the platform key. */
	modelId: string;
	/** Defaults to the organization of the active scope, captured now. Tests may pass a runner. */
	run?: RunInOrg;
	organizationId?: string;
};

/**
 * Wraps `model` so each call is recorded. Must be built inside an organization scope (the organization is captured
 * now, because a stream outlives the request that started it). On the platform key the model must have a price, or this
 * throws before any call, and every call first checks the organization's quota.
 */
export function meterLanguageModel<M extends Parameters<typeof wrapLanguageModel>[0]["model"]>(
	model: M,
	options: MeterOptions,
) {
	const { metering } = options;
	const organizationId = options.organizationId ?? requireOrgId();
	const run: RunInOrg = options.run ?? captureOrgScope();
	// Fail closed: a model with no price is refused here, not recorded at zero later.
	if (metering.source === "platform") priceFor(options.modelId);

	const record = (usage: TokenUsage) =>
		recordUsage(
			{
				organizationId,
				userId: metering.userId,
				source: metering.source,
				feature: metering.feature,
				provider: options.provider,
				model: options.modelId,
				usage,
			},
			run,
		);
	const gate = async () => {
		if (metering.source === "platform") await assertWithinQuota(organizationId);
	};

	const middleware: LanguageModelMiddleware = {
		specificationVersion: "v4",
		wrapGenerate: async ({ doGenerate }) => {
			await gate();
			const result = await doGenerate();
			await record(tokenUsageOf(result.usage));
			return result;
		},
		wrapStream: async ({ doStream }) => {
			await gate();
			const { stream, ...rest } = await doStream();
			const reader = stream.getReader();
			let usage: ReportedUsage | undefined;
			let recorded = false;
			// Once per call, whichever way the stream ends: finished, failed, or abandoned by the reader.
			const finish = async () => {
				if (recorded) return;
				recorded = true;
				// The stream ended before the provider reported usage (abandoned or failed): the row is zero tokens, and this
				// line lets us see how often that happens.
				if (!usage)
					console.warn(
						JSON.stringify({
							evt: "ai_usage.no_usage_report",
							organizationId,
							feature: metering.feature,
							source: metering.source,
							model: options.modelId,
						}),
					);
				await record(tokenUsageOf(usage));
			};
			const metered = new ReadableStream<StreamPart>({
				async pull(controller) {
					try {
						const { done, value } = await reader.read();
						if (done) {
							await finish();
							controller.close();
							return;
						}
						if (value.type === "finish") usage = value.usage;
						controller.enqueue(value);
					} catch (error) {
						await finish();
						controller.error(error);
					}
				},
				async cancel(reason) {
					await finish();
					await reader.cancel(reason);
				},
			});
			return { stream: metered, ...rest };
		},
	};

	return wrapLanguageModel({ model, middleware, modelId: options.modelId, providerId: options.provider });
}
