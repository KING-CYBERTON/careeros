// CAREEROS (P3-T01, phase plan D4): feature keys and the order in which a feature is resolved. Pure: no database.

/** The feature keys of PRODUCT.md section 11. A key missing from a plan's `features` resolves down the chain below. */
export const FEATURE_KEYS = [
	"custom_domain",
	"job_discovery",
	"admin_analytics",
	"email_templates",
	"sso",
	"platform_ai",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * The last step of the chain: what a feature is when no org flag, plan entry or global flag says anything. Everything
 * defaults to off, so a feature that nobody configured is not granted (fail closed).
 */
export const FEATURE_DEFAULTS: Readonly<Record<FeatureKey, boolean>> = {
	custom_domain: false,
	job_discovery: false,
	admin_analytics: false,
	email_templates: false,
	sso: false,
	platform_ai: false,
};

export function isFeatureKey(key: string): key is FeatureKey {
	return (FEATURE_KEYS as readonly string[]).includes(key);
}

export type FeatureInputs = {
	/** The organization's own flags (`feature_flag` rows with this organization). */
	orgFlags: ReadonlyMap<string, boolean>;
	/** The plan's `features` map. */
	planFeatures: Readonly<Record<string, unknown>>;
	/** Global flags (`feature_flag` rows without an organization). */
	globalFlags: ReadonlyMap<string, boolean>;
};

/**
 * Resolves one feature in the D4 order: the organization's flag, then the plan's `features`, then the global flag,
 * then the code default. The first source that has an opinion wins, including an explicit `false`. A plan entry that
 * is not a boolean is ignored.
 */
export function resolveFeature(key: string, inputs: FeatureInputs): boolean {
	const orgFlag = inputs.orgFlags.get(key);
	if (orgFlag !== undefined) return orgFlag;
	const planValue = inputs.planFeatures[key];
	if (typeof planValue === "boolean") return planValue;
	const globalFlag = inputs.globalFlags.get(key);
	if (globalFlag !== undefined) return globalFlag;
	return isFeatureKey(key) ? FEATURE_DEFAULTS[key] : false;
}

/** Resolves every known key plus any other key a flag or the plan mentions, so a new key shows up without a code change. */
export function resolveFeatures(inputs: FeatureInputs): Record<string, boolean> {
	const keys = new Set<string>([
		...FEATURE_KEYS,
		...inputs.orgFlags.keys(),
		...Object.keys(inputs.planFeatures),
		...inputs.globalFlags.keys(),
	]);
	const resolved: Record<string, boolean> = {};
	for (const key of [...keys].sort()) resolved[key] = resolveFeature(key, inputs);
	return resolved;
}
