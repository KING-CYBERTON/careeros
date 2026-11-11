import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// CAREEROS (P3-T11): the discovery AI match builds its model on the selected platform provider. The model is built by
// an injected `buildModel`, so no test reaches a real provider.

const envMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@reactive-resume/env/server", () => ({ env: envMock }));
vi.mock("@careeros/billing", () => ({
	getEntitlements: vi.fn(async () => ({ features: { platform_ai: true } })),
}));
vi.mock("@careeros/ai-metering", async (original) => ({
	...(await original<typeof import("@careeros/ai-metering")>()),
	assertWithinQuota: vi.fn(async () => ({})),
}));
vi.mock("../ai/service", () => ({ getModel: vi.fn() }));

const { createPlatformMatcher } = await import("./ai-match");

const configure = (values: Record<string, unknown>) => {
	for (const key of Object.keys(envMock)) delete envMock[key];
	Object.assign(envMock, {
		CAREEROS_AI_MODEL_GENERATION: "claude-sonnet-5-5",
		CAREEROS_AI_MODEL_FAST: "claude-haiku-5-5",
		...values,
	});
};

const job = { id: "j1", title: "Engineer", company: "Acme", location: null, remote: null, description: "Build things" };
const profile = { titles: ["Engineer"], skills: [], keywords: [], locations: [], remote: "any" };

async function runMatch() {
	const buildModel = vi.fn(() => {
		// A model that fails at once: the test only reads how the model was built.
		throw new Error("stop");
	});
	const matcher = createPlatformMatcher({
		organizationId: "org-1",
		userId: "user-1",
		buildModel: buildModel as never,
	});
	await expect(matcher.match(job, profile)).rejects.toBeDefined();
	return buildModel;
}

describe("createPlatformMatcher", () => {
	beforeEach(() => configure({}));

	it("builds the platform model on anthropic by default", async () => {
		configure({ ANTHROPIC_API_KEY: "ant-key-placeholder" });
		const buildModel = await runMatch();
		expect(buildModel).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "anthropic",
				model: "claude-haiku-5-5",
				apiKey: "ant-key-placeholder",
				metering: { feature: "discovery.match", userId: "user-1", source: "platform" },
			}),
		);
	});

	it("builds it on openrouter with the mapped model and the OpenRouter key when selected", async () => {
		configure({
			CAREEROS_AI_PLATFORM_PROVIDER: "openrouter",
			ANTHROPIC_API_KEY: "ant-key-placeholder",
			OPENROUTER_API_KEY: "or-key-placeholder",
		});
		const buildModel = await runMatch();
		expect(buildModel).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "openrouter",
				model: "anthropic/claude-haiku-5.5",
				apiKey: "or-key-placeholder",
				metering: { feature: "discovery.match", userId: "user-1", source: "platform" },
			}),
		);
	});

	it("reports no platform AI on openrouter with no OpenRouter key", async () => {
		configure({ CAREEROS_AI_PLATFORM_PROVIDER: "openrouter", ANTHROPIC_API_KEY: "ant-key-placeholder" });
		const matcher = createPlatformMatcher({ organizationId: "org-1", userId: "user-1" });
		await expect(matcher.check()).resolves.toBe("no_platform_ai");
	});
});
