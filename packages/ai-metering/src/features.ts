// CAREEROS (P3-T03, phase plan D5): every kind of AI call the product makes, with the model tier it uses on the platform
// key. Model routing follows PRODUCT.md 8.4: the generation model for writing and reasoning, the fast model for
// classification and extraction. The keys are stored in `ai_usage.feature`.

export const AI_FEATURES = {
	"resume.improve": { fast: false, label: "Improve a line" },
	"resume.parse": { fast: true, label: "Import a resume file" },
	"ats.review": { fast: false, label: "Resume review" },
	"agent.turn": { fast: false, label: "Assistant" },
	"career.generate": { fast: false, label: "Career coaching" },
	"career.role_suggestions": { fast: false, label: "Target role suggestions" },
	"cover_letter.draft": { fast: false, label: "Cover letter drafts" },
	"applications.ai": { fast: false, label: "Application tools" },
	"applications.extract": { fast: true, label: "Read a job posting" },
	// CAREEROS (P5-T03): the Job Clipper's optional "Tidy with AI", on the platform provider only.
	"clipper.cleanup": { fast: true, label: "Tidy a clipped job" },
} as const satisfies Record<string, { fast: boolean; label: string }>;

export type AiFeature = keyof typeof AI_FEATURES;

export const AI_FEATURE_KEYS = Object.keys(AI_FEATURES) as AiFeature[];

export function isAiFeature(value: string): value is AiFeature {
	return Object.hasOwn(AI_FEATURES, value);
}

/** Whether the feature runs on the fast (small) model when the platform key is used. */
export function isFastFeature(feature: AiFeature): boolean {
	return AI_FEATURES[feature].fast;
}
