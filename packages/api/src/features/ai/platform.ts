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

/** Whether the server has a platform key at all. */
export const platformKeyConfigured = () => Boolean(env.ANTHROPIC_API_KEY);

/** The model the platform key uses for a feature: the fast model for classification and extraction, else the other. */
export function platformModelFor(feature: AiFeature): string {
	const model = isFastFeature(feature) ? env.CAREEROS_AI_MODEL_FAST : env.CAREEROS_AI_MODEL_GENERATION;
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
	const key = env.ANTHROPIC_API_KEY;
	if (!key) throw new Error("PLATFORM_AI_UNAVAILABLE");
	return key;
}

/** Whether `apiKey` is the platform key (so `getModel` can insist the call is metered as a platform call). */
export const isPlatformApiKey = (apiKey: string) => Boolean(env.ANTHROPIC_API_KEY) && apiKey === env.ANTHROPIC_API_KEY;
