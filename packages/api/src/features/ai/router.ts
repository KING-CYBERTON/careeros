// CAREEROS (P3-T03)
import type { AiFeature } from "@careeros/ai-metering";
import { getQuotaState } from "@careeros/ai-metering";
import { requireOrgId } from "@careeros/tenancy";
import { ORPCError } from "@orpc/client";
import { AISDKError } from "ai";
import { flattenError, ZodError, z } from "zod";
import { resumeDataSchema } from "@reactive-resume/schema/resume/data";
import { protectedProcedure } from "../../context";
import { aiRequestRateLimit } from "../../middleware/rate-limit";
import { aiProvidersService } from "../ai-providers/service";
import { atsReviewInputSchema, atsReviewOutputSchema, reviewResumeText } from "./ats-review";
import { improveInputSchema, improveLine, improveOutputSchema } from "./improve";
import { reportAiContent } from "./reports";
import { aiService, fileInputSchema } from "./service";

/**
 * Every AI procedure fails the same ways: no ENCRYPTION_SECRET, a bad base URL, the provider erroring (its cause kept
 * for upstream error reporters), or the model returning a shape that can't be used, named per procedure.
 */
function rethrowAiError(error: unknown, invalidStructure: string): never {
	if (error instanceof Error && error.message === "AI_CREDENTIAL_ENCRYPTION_UNAVAILABLE")
		throw new ORPCError("PRECONDITION_FAILED", {
			message: "AI providers aren't available on this server. Ask the server administrator to set ENCRYPTION_SECRET.",
		});
	if (error instanceof Error && error.message === "INVALID_AI_BASE_URL")
		throw new ORPCError("BAD_REQUEST", {
			message: "That provider setup isn't valid. Check the base URL and try again.",
		});
	if (error instanceof AISDKError)
		throw new ORPCError("BAD_GATEWAY", {
			message: "Couldn't reach the AI provider. Check its settings and try again.",
			cause: error,
		});
	if (error instanceof ZodError)
		throw new ORPCError("BAD_REQUEST", { message: invalidStructure, cause: flattenError(error) });
	throw error;
}

const aiErrors = {
	BAD_GATEWAY: {
		message: "The AI provider returned an error or couldn't be reached. Try again, or check its settings.",
		status: 502,
	},
	BAD_REQUEST: {
		message: "The AI response wasn't in the expected format. Try again, or choose another model.",
		status: 400,
	},
} as const;

// CAREEROS (P3-T03): the feature picks the platform model and names the call in ai_usage
async function getRunnableProvider(userId: string, feature: AiFeature, aiProviderId?: string) {
	const provider = aiProviderId
		? await aiProvidersService.getRunnableById({ id: aiProviderId, userId, feature })
		: await aiProvidersService.getDefaultRunnable({ userId, feature });

	if (!provider)
		throw new ORPCError("BAD_REQUEST", {
			message: "Test and turn on an AI provider in Settings → AI & developer first.",
		});

	return provider;
}

export const aiRouter = {
	reportContent: reportAiContent,
	// CAREEROS (P3-T03): the organization's pooled AI credits, for the 80% toast and the providers screen. Any member.
	quota: protectedProcedure
		.route({
			method: "GET",
			path: "/ai/quota",
			tags: ["AI"],
			operationId: "getAiQuota",
			summary: "Get the organization's AI allowance",
			description:
				"Returns the credits the organization has used of its pooled platform AI allowance in the current period, and the allowance. Any member can read it. Requires authentication.",
		})
		.input(z.object({}).optional())
		.output(
			z.object({
				used: z.number().int(),
				allowance: z.number().int(),
				warning: z.boolean().describe("80% or more of the allowance is used."),
				blocked: z.boolean().describe("The allowance is used up and platform AI calls are refused."),
			}),
		)
		.handler(async () => {
			const { used, allowance, warning, blocked } = await getQuotaState(requireOrgId());
			return { used, allowance, warning, blocked };
		}),

	parsePdf: protectedProcedure
		.route({
			method: "POST",
			path: "/ai/parse-pdf",
			tags: ["AI"],
			operationId: "parseResumePdf",
			summary: "Parse a PDF file into resume data",
			description:
				"Extracts structured resume data from a PDF file with one of the user's saved AI providers: the one named by `aiProviderId`, or their default. Send the file as a base64-encoded string. Returns a complete ResumeData object and saves nothing.",
			successDescription: "The PDF was successfully parsed into structured resume data.",
		})
		.input(z.object({ aiProviderId: z.string().optional(), file: fileInputSchema }))
		.use(aiRequestRateLimit)
		.errors(aiErrors)
		.output(resumeDataSchema)
		.handler(async ({ context, input }) => {
			try {
				const provider = await getRunnableProvider(context.user.id, "resume.parse", input.aiProviderId);
				return await aiService.parsePdf({
					provider: provider.provider,
					model: provider.model,
					apiKey: provider.apiKey,
					baseURL: provider.baseURL ?? "",
					metering: provider.metering,
					file: input.file,
				});
			} catch (error) {
				rethrowAiError(error, "The AI returned resume data in the wrong format. Try again, or choose another model.");
			}
		}),

	parseDocx: protectedProcedure
		.route({
			method: "POST",
			path: "/ai/parse-docx",
			tags: ["AI"],
			operationId: "parseResumeDocx",
			summary: "Parse a DOCX file into resume data",
			description:
				"Extracts structured resume data from a DOCX or DOC file with one of the user's saved AI providers: the one named by `aiProviderId`, or their default. Send the file as a base64-encoded string with the document's media type. Returns a complete ResumeData object and saves nothing.",
			successDescription: "The DOCX was successfully parsed into structured resume data.",
		})
		.input(
			z.object({
				aiProviderId: z.string().optional(),
				file: fileInputSchema,
				mediaType: z.enum([
					"application/msword",
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				]),
			}),
		)
		.use(aiRequestRateLimit)
		.errors(aiErrors)
		.output(resumeDataSchema)
		.handler(async ({ context, input }) => {
			try {
				const provider = await getRunnableProvider(context.user.id, "resume.parse", input.aiProviderId);
				return await aiService.parseDocx({
					provider: provider.provider,
					model: provider.model,
					apiKey: provider.apiKey,
					baseURL: provider.baseURL ?? "",
					metering: provider.metering,
					mediaType: input.mediaType,
					file: input.file,
				});
			} catch (error) {
				rethrowAiError(error, "The AI returned resume data in the wrong format. Try again, or choose another model.");
			}
		}),

	atsReview: protectedProcedure
		.route({
			method: "POST",
			path: "/ai/ats-review",
			tags: ["AI"],
			operationId: "atsReview",
			summary: "Review extracted resume text",
			description:
				"Reviews the plain text extracted from a resume PDF and returns qualitative feedback: a summary, rewrite suggestions, strengths, and — when a job description is supplied — how the candidate's experience lines up with the role. Deliberately returns no score: the deterministic ATS report owns the only number in this feature. Requires authentication and AI credentials.",
			successDescription: "Qualitative review returned successfully.",
		})
		.input(atsReviewInputSchema)
		.use(aiRequestRateLimit)
		.output(atsReviewOutputSchema)
		.errors(aiErrors)
		.handler(async ({ context, input }) => {
			try {
				const provider = await getRunnableProvider(context.user.id, "ats.review", input.aiProviderId);

				return await reviewResumeText({
					...input,
					provider: provider.provider,
					model: provider.model,
					apiKey: provider.apiKey,
					baseURL: provider.baseURL ?? "",
					metering: provider.metering,
				});
			} catch (error) {
				rethrowAiError(error, "The AI returned the review in the wrong format. Try again, or choose another model.");
			}
		}),

	improve: protectedProcedure
		.route({
			method: "POST",
			path: "/ai/improve",
			tags: ["AI"],
			operationId: "improveLine",
			summary: "Suggest a rewrite of one line",
			description:
				"Suggests a rewrite of one line of a resume or cover letter: a stronger verb, an added result, a shorter version, or the user's own request. Returns the new line, a short reason, and whether it states anything the input didn't, so the user can check it. Writes nothing. Requires authentication and AI credentials.",
			successDescription: "The suggested line.",
		})
		.input(improveInputSchema)
		.use(aiRequestRateLimit)
		.output(improveOutputSchema)
		.errors(aiErrors)
		.handler(async ({ context, input }) => {
			try {
				const provider = await getRunnableProvider(context.user.id, "resume.improve", input.aiProviderId);

				return await improveLine({
					...input,
					provider: provider.provider,
					model: provider.model,
					apiKey: provider.apiKey,
					baseURL: provider.baseURL ?? "",
					metering: provider.metering,
				});
			} catch (error) {
				rethrowAiError(error, "The AI returned suggestions in the wrong format. Try again, or choose another model.");
			}
		}),
};
