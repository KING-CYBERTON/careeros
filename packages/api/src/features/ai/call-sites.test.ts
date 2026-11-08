import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { generateText, streamText } from "ai";

// CAREEROS (P3-T03, phase plan D5): every AI call that can reach the platform key is metered. Two halves:
//  1. a walk over the source of every call site, so a new AI call that skips the metered model fails here (P3-Q01
//     builds on this list), and
//  2. a run through the real `getModel` with a stubbed provider endpoint, proving the model it returns records usage and
//     that the platform key is refused without metering.
// No test calls the real Claude API: the provider request is a stubbed `fetch`.

const PLATFORM_KEY = "sk-ant-test-placeholder-not-a-secret";

const mocks = vi.hoisted(() => ({
	recordUsage: vi.fn(async (_record: unknown) => undefined),
	assertWithinQuota: vi.fn(async () => ({})),
}));
vi.mock("@reactive-resume/env/server", () => ({
	env: { FLAG_ALLOW_UNSAFE_AI_BASE_URL: false, ANTHROPIC_API_KEY: "sk-ant-test-placeholder-not-a-secret" },
}));
vi.mock("@careeros/tenancy", () => ({
	requireOrgId: () => "org-test",
	currentOrgId: () => "org-test",
	captureOrgScope: () => (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../../../../ai-metering/src/recorder", async (original) => ({
	...(await original<typeof import("../../../../ai-metering/src/recorder")>()),
	recordUsage: mocks.recordUsage,
}));
vi.mock("../../../../ai-metering/src/quota", async (original) => ({
	...(await original<typeof import("../../../../ai-metering/src/quota")>()),
	assertWithinQuota: mocks.assertWithinQuota,
}));
const fetchPublicMock = vi.hoisted(() => vi.fn((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)));
vi.mock("@reactive-resume/utils/url-security.node", async (original) => ({
	...(await original<typeof import("@reactive-resume/utils/url-security.node")>()),
	fetchPublic: fetchPublicMock,
}));

const FEATURES = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

const sources = new Map(sourceFiles(FEATURES).map((path) => [relative(FEATURES, path), readFileSync(path, "utf8")]));

/** The text of a call's argument list, from its opening parenthesis to the matching one. */
function argumentsAt(source: string, openParen: number): string {
	let depth = 0;
	for (let index = openParen; index < source.length; index += 1) {
		if (source[index] === "(") depth += 1;
		if (source[index] === ")" && --depth === 0) return source.slice(openParen + 1, index);
	}
	return source.slice(openParen + 1);
}

function callsOf(source: string, name: string): { args: string; inFunction: string }[] {
	const found: { args: string; inFunction: string }[] = [];
	for (const match of source.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g"))) {
		const before = source.slice(Math.max(0, match.index - 20), match.index);
		if (/function\s+$/.test(before)) continue;
		const head = source.slice(0, match.index);
		const functions = [...head.matchAll(/(?:async\s+)?function\s+(\w+)/g)];
		found.push({
			args: argumentsAt(source, match.index + match[0].length - 1),
			inFunction: functions.at(-1)?.[1] ?? "",
		});
	}
	return found;
}

/**
 * Every file that builds or runs a language model. Adding an AI call in a new file fails the first test below until
 * the file is listed here, with the way it is metered.
 */
const AI_CALL_FILES = {
	"ai/service.ts": "getModel and getAgentModel define the metered model; parsePdf and parseDocx forward `metering`",
	"ai/generate-json.ts": "takes the model it is given",
	"ai/improve.ts": "getModel(input), input carries `metering`",
	"ai/ats-review.ts": "getModel(input), input carries `metering`",
	"agent/service.ts": "getAgentModel({ ..., metering })",
	"career/generate.ts": "getModel({ ..., metering })",
	"career/role-suggestions.ts": "getModel({ ..., metering })",
	"cover-letters/draft.ts": "getModel({ ..., metering })",
	"applications/ai.ts": "getModel({ ..., metering }) in resolveModel and in the posting enrichment",
	"clipper/cleanup.ts":
		"getModel({ ..., metering }) on the platform runnable only (getPlatformRunnable), never a saved key",
	"career/voice.ts":
		"transcription and speech on the member's own OpenAI-style key; no platform model exists for them (see below)",
} as const;

const MODEL_CALL = /\b(getModel|getAgentModel|generateText|streamText|ToolLoopAgent|generateSpeech|transcribe)\s*\(/;

describe("the AI call sites", () => {
	it("are exactly the confirmed list", () => {
		const files = [...sources]
			.filter(([, text]) => MODEL_CALL.test(text.replace(/\/\/.*$/gm, "")))
			.map(([file]) => file);
		// The providers service resolves connections (it never calls a model) and the capabilities file only names providers.
		expect(files.sort()).toEqual(Object.keys(AI_CALL_FILES).sort());
	});

	it("build every model with metering, or forward an input that carries it", () => {
		const unmetered: string[] = [];
		for (const [file, source] of sources) {
			for (const name of ["getModel", "getAgentModel"]) {
				for (const call of callsOf(source, name)) {
					const forwardsInput = /^\s*input\s*$/.test(call.args) && /metering\?:\s*Metering/.test(source);
					// The connection test of a saved key ("Test" in Settings) is not an AI feature and never uses the platform key.
					const exempt = file === "ai/service.ts" && call.inFunction === "testConnection";
					// getAgentModel falls back to getModel with the same input.
					const fallsBack = file === "ai/service.ts" && call.inFunction === "getAgentModel";
					if (!/\bmetering\b/.test(call.args) && !forwardsInput && !exempt && !fallsBack)
						unmetered.push(`${file}: ${name}(${call.args.trim().slice(0, 60)})`);
				}
			}
		}
		expect(unmetered).toEqual([]);
	});

	it("resolve every provider with the feature they serve", () => {
		const unnamed: string[] = [];
		for (const [file, source] of sources) {
			if (file.startsWith("ai-providers/")) continue;
			for (const name of ["getRunnableById", "getDefaultRunnable", "getPlatformRunnable"]) {
				for (const call of callsOf(source, name)) {
					// Voice has no platform feature: it must stay unable to resolve the platform provider.
					if (file === "career/voice.ts") {
						expect(call.args).not.toMatch(/feature/);
						continue;
					}
					if (!/\bfeature\b/.test(call.args)) unnamed.push(`${file}: ${name}(${call.args.trim().slice(0, 60)})`);
				}
			}
		}
		expect(unnamed).toEqual([]);
	});

	it("name only features of the AI feature list", async () => {
		const { AI_FEATURE_KEYS } = await import("@careeros/ai-metering");
		const used = new Set<string>();
		for (const [file, source] of sources) {
			if (file.startsWith("ai-providers/") || file === "ai/platform.ts") continue;
			for (const match of source.matchAll(/feature:\s*"([a-z_]+\.[a-z_.]+)"/g)) used.add(match[1] ?? "");
			for (const match of source.matchAll(/(?:getRunnableProvider\([^,]+,|resolveModel\([^,]+,)\s*"([a-z_.]+)"/g))
				used.add(match[1] ?? "");
		}
		expect([...used].sort()).toEqual(
			expect.arrayContaining(["agent.turn", "ats.review", "career.generate", "cover_letter.draft", "resume.improve"]),
		);
		for (const feature of used) expect(AI_FEATURE_KEYS).toContain(feature);
	});

	it("meter every path that is not a member's own key: the platform and the server-managed AI", () => {
		const providers = sources.get("ai-providers/service.ts") ?? "";
		// Every resolution of the operator's AI goes through serverRunnable (priced, quota-checked, source "platform").
		const serverUses = [...providers.matchAll(/if \(global\) return ([\w]+)\(/g)].map((match) => match[1]);
		expect(serverUses.length).toBeGreaterThanOrEqual(2);
		expect(new Set(serverUses)).toEqual(new Set(["serverRunnable"]));
		// Only a member's saved key is metered as `own_key`.
		const ownKeyLines = providers.split("\n").filter((line) => line.includes('source: "own_key"'));
		expect(ownKeyLines.length).toBeGreaterThan(0);
		expect(providers).not.toMatch(/withMetering\(global,[^)]*own_key/);
		// Voice cannot be metered, so it refuses both.
		expect(sources.get("career/voice.ts")).toMatch(/provider\.managed \|\| provider\.platform/);
	});

	it("leave voice without a platform model", async () => {
		const { AI_VOICE_MODELS } = await import("@reactive-resume/ai/types");
		// The platform provider is Anthropic. A connection that offers no voice model is refused by the voice routes
		// before its key is used.
		expect(AI_VOICE_MODELS.anthropic).toBeUndefined();
	});
});

describe("getModel on the platform key", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							id: "msg_test",
							type: "message",
							role: "assistant",
							model: "claude-sonnet-5-5",
							content: [{ type: "text", text: "ok" }],
							stop_reason: "end_turn",
							stop_sequence: null,
							usage: { input_tokens: 120, output_tokens: 30 },
						}),
						{ headers: { "content-type": "application/json" } },
					),
			),
		);
	});

	it("refuses the platform key without metering, so an unmetered call site cannot use it", async () => {
		const { getModel, getAgentModel } = await import("./service");
		const input = { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: PLATFORM_KEY } as const;
		expect(() => getModel(input)).toThrow("PLATFORM_KEY_UNMETERED");
		expect(() => getAgentModel(input)).toThrow("PLATFORM_KEY_UNMETERED");
		// Metering that says "own key" does not unlock it either.
		expect(() =>
			getModel({ ...input, metering: { feature: "resume.improve", userId: "u1", source: "own_key" } }),
		).toThrow("PLATFORM_KEY_UNMETERED");
	});

	it("returns a model that records a platform row after a generate", async () => {
		const { getModel } = await import("./service");
		const model = getModel({
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			apiKey: PLATFORM_KEY,
			metering: { feature: "resume.improve", userId: "u1", source: "platform" },
		});
		await expect(generateText({ model, prompt: "hi" })).resolves.toMatchObject({ text: "ok" });
		expect(mocks.assertWithinQuota).toHaveBeenCalledWith("org-test");
		expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
		expect(mocks.recordUsage.mock.calls[0]?.[0]).toMatchObject({
			organizationId: "org-test",
			userId: "u1",
			source: "platform",
			feature: "resume.improve",
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0 },
		});
	});

	it("records an own-key call the same way, without checking the quota", async () => {
		const { getModel } = await import("./service");
		const model = getModel({
			provider: "anthropic",
			model: "claude-haiku-4-5",
			apiKey: "sk-ant-a-members-own-key",
			metering: { feature: "cover_letter.draft", userId: "u2", source: "own_key" },
		});
		await streamText({ model, prompt: "hi", onError: () => undefined }).consumeStream({ onError: () => undefined });
		expect(mocks.assertWithinQuota).not.toHaveBeenCalled();
		expect(mocks.recordUsage.mock.calls[0]?.[0]).toMatchObject({ source: "own_key", feature: "cover_letter.draft" });
	});

	it("refuses a platform model that has no price before it calls the provider", async () => {
		const { getModel } = await import("./service");
		expect(() =>
			getModel({
				provider: "anthropic",
				model: "claude-not-in-the-table",
				apiKey: PLATFORM_KEY,
				metering: { feature: "agent.turn", userId: "u1", source: "platform" },
			}),
		).toThrow(/no price/);
		expect(fetch).not.toHaveBeenCalled();
	});
});
