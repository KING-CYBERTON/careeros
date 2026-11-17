import type { AiFeature } from "./features";
import { withOrgContext } from "@careeros/tenancy";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { costOfCall, type TokenUsage } from "./credits";

// CAREEROS (P3-T03, phase plan D5): the usage recorder. One row per metered call.

export type UsageSource = "platform" | "own_key";

export type UsageRecord = {
	organizationId: string;
	userId: string | null;
	source: UsageSource;
	feature: AiFeature;
	provider: string;
	model: string;
	usage: TokenUsage;
};

/** Runs a function in the organization's database scope; `captureOrgScope()` from `@careeros/tenancy` fits. */
export type RunInOrg = <T>(fn: () => Promise<T>) => Promise<T>;

let writeFailures = 0;

function reasonOf(error: unknown): string {
	const cause = error instanceof Error ? error.cause : undefined;
	if (cause instanceof Error) return cause.message;
	return error instanceof Error ? (error.message.split("\n")[0] ?? "unknown") : "unknown";
}

/** How many usage writes have failed in this process. Q01 asserts on this and on the `ai_usage.write_failed` log line. */
export function usageWriteFailureCount(): number {
	return writeFailures;
}

/** Test helper: start the failure counter at zero. */
export function resetUsageWriteFailureCount(): void {
	writeFailures = 0;
}

/**
 * Writes one `ai_usage` row inside the organization's context, so row-level security applies. Platform rows carry the
 * cost and credits from the price table; own-key rows always carry zero. A failed write never throws: the user keeps the
 * result they paid the provider for. It is logged at error level with the organization and feature, and counted.
 */
export async function recordUsage(record: UsageRecord, run?: RunInOrg): Promise<void> {
	try {
		const cost =
			record.source === "platform" ? costOfCall(record.model, record.usage) : { costUsdMicros: 0, credits: 0 };
		const insert = () =>
			db.insert(schema.aiUsage).values({
				organizationId: record.organizationId,
				userId: record.userId,
				source: record.source,
				feature: record.feature,
				provider: record.provider,
				model: record.model,
				inputTokens: Math.max(0, Math.floor(record.usage.inputTokens)),
				outputTokens: Math.max(0, Math.floor(record.usage.outputTokens)),
				cachedInputTokens: Math.max(0, Math.floor(record.usage.cachedInputTokens)),
				costUsdMicros: cost.costUsdMicros,
				credits: cost.credits,
			});
		await (run ?? ((fn) => withOrgContext(record.organizationId, fn)))(insert);
	} catch (error) {
		writeFailures += 1;
		// No prompts, keys or tokens: the organization, the feature and the reason are enough to find the call.
		console.error(
			JSON.stringify({
				evt: "ai_usage.write_failed",
				organizationId: record.organizationId,
				feature: record.feature,
				source: record.source,
				// Drizzle wraps the driver error and its message repeats the statement, so the cause is the useful part.
				error: reasonOf(error),
			}),
		);
	}
}
