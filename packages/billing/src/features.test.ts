import { describe, expect, it } from "vite-plus/test";
import { FEATURE_DEFAULTS, FEATURE_KEYS, isFeatureKey, resolveFeature, resolveFeatures } from "./features";

const inputs = (parts: {
	org?: Record<string, boolean>;
	plan?: Record<string, unknown>;
	global?: Record<string, boolean>;
}) => ({
	orgFlags: new Map(Object.entries(parts.org ?? {})),
	planFeatures: parts.plan ?? {},
	globalFlags: new Map(Object.entries(parts.global ?? {})),
});

describe("feature keys", () => {
	it("lists the keys of PRODUCT.md section 11 and defaults every one to off", () => {
		expect([...FEATURE_KEYS].sort()).toEqual(
			["admin_analytics", "custom_domain", "email_templates", "job_discovery", "platform_ai", "sso"].sort(),
		);
		for (const key of FEATURE_KEYS) expect(FEATURE_DEFAULTS[key]).toBe(false);
		expect(isFeatureKey("sso")).toBe(true);
		expect(isFeatureKey("nope")).toBe(false);
	});
});

describe("feature resolution order (D4)", () => {
	it("falls back to the code default when nothing has an opinion", () => {
		expect(resolveFeature("sso", inputs({}))).toBe(false);
		expect(resolveFeature("some_future_key", inputs({}))).toBe(false);
	});

	it("uses the global flag over the code default", () => {
		expect(resolveFeature("sso", inputs({ global: { sso: true } }))).toBe(true);
	});

	it("uses the plan over the global flag, including an explicit false", () => {
		expect(resolveFeature("sso", inputs({ plan: { sso: true }, global: { sso: false } }))).toBe(true);
		expect(resolveFeature("sso", inputs({ plan: { sso: false }, global: { sso: true } }))).toBe(false);
	});

	it("uses the organization flag over everything, in both directions", () => {
		expect(resolveFeature("sso", inputs({ org: { sso: true }, plan: { sso: false }, global: { sso: false } }))).toBe(
			true,
		);
		expect(resolveFeature("sso", inputs({ org: { sso: false }, plan: { sso: true }, global: { sso: true } }))).toBe(
			false,
		);
	});

	it("ignores a plan entry that is not a boolean", () => {
		expect(resolveFeature("sso", inputs({ plan: { sso: "yes" }, global: { sso: true } }))).toBe(true);
		expect(resolveFeature("sso", inputs({ plan: { sso: 1 } }))).toBe(false);
	});

	it("resolves every known key, plus keys that only a flag or the plan mentions", () => {
		const resolved = resolveFeatures(
			inputs({ org: { beta_thing: true }, plan: { custom_domain: true }, global: { x_y: false } }),
		);
		for (const key of FEATURE_KEYS) expect(resolved).toHaveProperty(key);
		expect(resolved.custom_domain).toBe(true);
		expect(resolved.beta_thing).toBe(true);
		expect(resolved.x_y).toBe(false);
		expect(resolved.sso).toBe(false);
	});
});

// CAREEROS (P4-T02): `discovery_ai_top_n` is a number on the plan, not a feature flag
describe("discovery_ai_top_n", () => {
	it("is not a feature key and stays out of the resolved feature map", () => {
		expect(isFeatureKey("discovery_ai_top_n")).toBe(false);
		expect(resolveFeatures(inputs({ plan: { discovery_ai_top_n: 10, custom_domain: true } }))).not.toHaveProperty(
			"discovery_ai_top_n",
		);
	});
});
