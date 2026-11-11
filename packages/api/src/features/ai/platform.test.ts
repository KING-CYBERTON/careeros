import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// CAREEROS (P3-T11): the platform provider selection, key selection and model mapping. The environment is mocked; no
// test calls a real provider.

const envMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@reactive-resume/env/server", () => ({ env: envMock }));
vi.mock("@careeros/billing", () => ({
	getEntitlements: vi.fn(async () => ({ features: { platform_ai: true } })),
}));

const platform = await import("./platform");

const configure = (values: Record<string, unknown>) => {
	for (const key of Object.keys(envMock)) delete envMock[key];
	Object.assign(envMock, {
		CAREEROS_AI_MODEL_GENERATION: "claude-sonnet-5-5",
		CAREEROS_AI_MODEL_FAST: "claude-haiku-5-5",
		CAREEROS_AI_PLATFORM_PROVIDER: "anthropic",
		...values,
	});
};

describe("platform provider selection", () => {
	beforeEach(() => configure({}));

	it("is anthropic by default and openrouter when selected", () => {
		expect(platform.platformProvider()).toBe("anthropic");
		configure({ CAREEROS_AI_PLATFORM_PROVIDER: "openrouter" });
		expect(platform.platformProvider()).toBe("openrouter");
	});

	it("uses the selected provider's key and never falls back to the other", () => {
		configure({ ANTHROPIC_API_KEY: "ant-key", OPENROUTER_API_KEY: "or-key" });
		expect(platform.platformApiKey()).toBe("ant-key");
		expect(platform.isPlatformApiKey("ant-key")).toBe(true);
		expect(platform.isPlatformApiKey("or-key")).toBe(false);

		configure({
			CAREEROS_AI_PLATFORM_PROVIDER: "openrouter",
			ANTHROPIC_API_KEY: "ant-key",
			OPENROUTER_API_KEY: "or-key",
		});
		expect(platform.platformApiKey()).toBe("or-key");
		expect(platform.isPlatformApiKey("or-key")).toBe(true);
		expect(platform.isPlatformApiKey("ant-key")).toBe(false);
	});

	it("is not configured on openrouter with no OpenRouter key, even with an Anthropic key", async () => {
		configure({ CAREEROS_AI_PLATFORM_PROVIDER: "openrouter", ANTHROPIC_API_KEY: "ant-key" });
		expect(platform.platformKeyConfigured()).toBe(false);
		expect(platform.isPlatformApiKey("ant-key")).toBe(false);
		expect(() => platform.platformApiKey()).toThrow("PLATFORM_AI_UNAVAILABLE");
		await expect(platform.platformAiAvailable("org-1")).resolves.toBe(false);
	});

	it("is not configured on anthropic with only an OpenRouter key", () => {
		configure({ OPENROUTER_API_KEY: "or-key" });
		expect(platform.platformKeyConfigured()).toBe(false);
	});
});

describe("platformModelFor", () => {
	it("keeps the canonical id on anthropic", () => {
		configure({});
		expect(platform.platformModelFor("agent.turn")).toBe("claude-sonnet-5-5");
		expect(platform.platformModelFor("resume.parse")).toBe("claude-haiku-5-5");
	});

	it("maps canonical ids to OpenRouter slugs on openrouter", () => {
		configure({ CAREEROS_AI_PLATFORM_PROVIDER: "openrouter" });
		expect(platform.OPENROUTER_MODEL_SLUGS).toEqual({
			"claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
			"claude-haiku-5-5": "anthropic/claude-haiku-5.5",
		});
		expect(platform.platformModelFor("agent.turn")).toBe("anthropic/claude-sonnet-5.5");
		expect(platform.platformModelFor("resume.parse")).toBe("anthropic/claude-haiku-5.5");
	});

	it("uses an id with a slash as given on openrouter, and refuses it when it has no price", () => {
		configure({
			CAREEROS_AI_PLATFORM_PROVIDER: "openrouter",
			CAREEROS_AI_MODEL_GENERATION: "anthropic/claude-sonnet-5.5",
		});
		expect(platform.platformModelFor("agent.turn")).toBe("anthropic/claude-sonnet-5.5");
		configure({ CAREEROS_AI_PLATFORM_PROVIDER: "openrouter", CAREEROS_AI_MODEL_GENERATION: "openai/gpt-5" });
		expect(() => platform.platformModelFor("agent.turn")).toThrow(/no price/);
	});

	it("refuses an unmapped id with no slash on openrouter", () => {
		configure({ CAREEROS_AI_PLATFORM_PROVIDER: "openrouter", CAREEROS_AI_MODEL_GENERATION: "some-model" });
		expect(() => platform.platformModelFor("agent.turn")).toThrow("PLATFORM_AI_MODEL_UNMAPPED");
		// Prototype keys are not models.
		configure({ CAREEROS_AI_PLATFORM_PROVIDER: "openrouter", CAREEROS_AI_MODEL_GENERATION: "constructor" });
		expect(() => platform.platformModelFor("agent.turn")).toThrow("PLATFORM_AI_MODEL_UNMAPPED");
	});
});
