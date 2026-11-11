import { isFastFeature, priceFor, type AiFeature } from "@careeros/ai-metering";
import { getEntitlements } from "@careeros/billing";
import { env } from "@reactive-resume/env/server";

// CAREEROS (P3-T03, phase plan D5): the platform Claude provider. The platform key lives in the environment only. It is
// never returned by an API, never logged and never stored in `ai_provider`; this module is the only reader of it.

/** Where the platform entry of the providers list gets its label. */
export const PLATFORM_PROVIDER_LABEL = "Included with your plan";

/** The reference row id for the platform provider (threads and schedules keep a foreign key to it, never a key). */
export const platformProviderId = (organizationId: string, userId: string) => `platform-ai:${organizationId}:${userId}`;

export const isPlatformProviderId = (id: string) => id.startsWith("platform-ai:");

/** CAREEROS (P3-T11): the provider the platform key belongs to. One at a time; "anthropic" unless the operator opts in. */
export type PlatformProvider = "anthropic" | "openrouter";

export const platformProvider = (): PlatformProvider =>
	env.CAREEROS_AI_PLATFORM_PROVIDER === "openrouter" ? "openrouter" : "anthropic";

/** The selected provider's key. No fallback to the other provider's key. */
const selectedKey = () => (platformProvider() === "openrouter" ? env.OPENROUTER_API_KEY : env.ANTHROPIC_API_KEY);

/** Whether the server has a platform key at all (for the selected provider). */
export const platformKeyConfigured = () => Boolean(selectedKey());

/** CAREEROS (P3-T11, D2): canonical model id to OpenRouter slug. The ids in config stay canonical. */
export const OPENROUTER_MODEL_SLUGS: Readonly<Record<string, string>> = {
	"claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
	"claude-haiku-5-5": "anthropic/claude-haiku-5.5",
};

/** The id sent on the wire. Under OpenRouter an id with a slash is used as given, else it must be in the slug map. */
function wireModelId(model: string): string {
	if (platformProvider() !== "openrouter" || model.includes("/")) return model;
	const slug = Object.hasOwn(OPENROUTER_MODEL_SLUGS, model) ? OPENROUTER_MODEL_SLUGS[model] : undefined;
	// Fail closed: an unmapped id is not guessed at.
	if (!slug) throw new Error(`PLATFORM_AI_MODEL_UNMAPPED: "${model}" has no OpenRouter slug`);
	return slug;
}

/** The model the platform key uses for a feature: the fast model for classification and extraction, else the other. */
export function platformModelFor(feature: AiFeature): string {
	const configured = isFastFeature(feature) ? env.CAREEROS_AI_MODEL_FAST : env.CAREEROS_AI_MODEL_GENERATION;
	const model = wireModelId(configured);
	// Fail closed and early: a configured model with no price is refused before anything is resolved.
	priceFor(model);
	return model;
}

/** Whether platform AI applies to the organization: a key is configured and its plan includes `platform_ai`. */
export async function platformAiAvailable(organizationId: string): Promise<boolean> {
	if (!platformKeyConfigured()) return false;
	return (await getEntitlements(organizationId)).features.platform_ai === true;
}

/** The platform key. Only `getModel` and the providers service call this, and only for a metered call. */
export function platformApiKey(): string {
	const key = selectedKey();
	if (!key) throw new Error("PLATFORM_AI_UNAVAILABLE");
	return key;
}

/** Whether `apiKey` is the platform key (so `getModel` can insist the call is metered as a platform call). */
export const isPlatformApiKey = (apiKey: string) => {
	const key = selectedKey();
	return Boolean(key) && apiKey === key;
};
