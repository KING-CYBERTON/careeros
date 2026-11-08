import { ORPCError } from "@orpc/client";
import { APICallError, RetryError } from "ai";
import z from "zod";
import { aiProvidersService } from "../ai-providers/service";
import { generateJson } from "../ai/generate-json";
import { getModel } from "../ai/service";
import { buildPrompt, type ClippedFields, SYSTEM_PROMPT, validateCleanup } from "./fields";

// CAREEROS (P5-T03): the optional "Tidy with AI" step of the Job Clipper. It runs on the platform provider only and never
// on a member's saved key: `getPlatformRunnable` is the one way in, it checks the plan and the quota first, and the model
// it gives back records one `ai_usage` row per call. The page text is untrusted: it goes into a delimited data block, the
// system prompt says it is data and never instructions, and whatever the model answers is validated and cleaned to the
// same fields and caps as a clip (fields.ts). An answer that does not validate changes nothing.

export type TidyResult = { tidied: boolean; fields: ClippedFields };

/** A model answer that could not be read as JSON or did not match the shape: nothing changes. */
function isUnreadableAnswer(error: unknown): boolean {
	return (
		error instanceof SyntaxError ||
		error instanceof z.ZodError ||
		(error instanceof ORPCError && error.code === "INTERNAL_SERVER_ERROR")
	);
}

/**
 * Tidies a clip with the platform model: one metered call, or none when the plan has no platform AI or the quota is
 * used up (those refuse before any model is built). Returns the member's fields untouched when the answer is invalid.
 */
export async function tidyClippedJob(input: {
	userId: string;
	fields: ClippedFields;
	signal?: AbortSignal | undefined;
}): Promise<TidyResult> {
	// The member's fields are cleaned first (no markup reaches the model or comes back unchanged). Nothing is spent on a
	// clip that has no title or company.
	const original = validateCleanup(input.fields);
	if (!original) throw new ORPCError("BAD_REQUEST", { message: "A clipped job needs a title and a company." });

	const runnable = await aiProvidersService.getPlatformRunnable({ userId: input.userId, feature: "clipper.cleanup" });
	const model = getModel({
		provider: runnable.provider,
		model: runnable.model,
		apiKey: runnable.apiKey,
		metering: runnable.metering,
	});
	let raw: unknown;
	try {
		// No retries: one request is one metered call.
		raw = await generateJson(
			model,
			{ system: SYSTEM_PROMPT, prompt: buildPrompt(original) },
			z.unknown(),
			input.signal,
			0,
		);
	} catch (error) {
		input.signal?.throwIfAborted();
		if (APICallError.isInstance(error) || RetryError.isInstance(error))
			throw new ORPCError("BAD_GATEWAY", { message: "Couldn't reach the AI. Try again in a moment.", cause: error });
		if (isUnreadableAnswer(error)) return { tidied: false, fields: original };
		throw error;
	}
	const fields = validateCleanup(raw);
	return fields ? { tidied: true, fields } : { tidied: false, fields: original };
}
