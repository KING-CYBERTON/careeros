import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { dbMock, queryMock, queryState, envMock } = vi.hoisted(() => {
	const envMock: Record<string, unknown> = { AUTH_SECRET: "synthetic-test-auth-secret" };
	const state = {
		rows: [] as unknown[],
		whereArg: undefined as unknown,
		orderByArgs: [] as unknown[],
		updateRows: undefined as unknown[] | undefined,
		updateWhere: undefined as unknown,
		insertedRow: undefined as unknown,
	};
	const query = {
		from: vi.fn(() => query),
		where: vi.fn((arg: unknown) => {
			state.whereArg = arg;
			return query;
		}),
		orderBy: vi.fn((...args: unknown[]) => {
			state.orderByArgs = args;
			return query;
		}),
		limit: vi.fn(async () => state.rows),
	};
	const update = {
		set: vi.fn(() => update),
		where: vi.fn((arg: unknown) => {
			state.updateWhere = arg;
			return update;
		}),
		returning: vi.fn(async () => state.updateRows ?? state.rows),
	};

	// CAREEROS (P3-T03): the server-managed reference row is upserted with insert ... on conflict ... returning.
	const insert = {
		values: vi.fn((row: Record<string, unknown>) => {
			state.insertedRow = row;
			return insert;
		}),
		onConflictDoUpdate: vi.fn(() => insert),
		returning: vi.fn(async () => [state.insertedRow]),
	};

	return {
		dbMock: { select: vi.fn(() => query), update: vi.fn(() => update), insert: vi.fn(() => insert) },
		queryMock: query,
		queryState: state,
		envMock,
	};
});

vi.mock("@reactive-resume/db/client", () => ({ db: dbMock }));
vi.mock("@reactive-resume/db/schema", () => ({
	aiProvider: {
		id: "ai_provider.id",
		userId: "ai_provider.user_id",
		label: "ai_provider.label",
		provider: "ai_provider.provider",
		model: "ai_provider.model",
		baseUrl: "ai_provider.base_url",
		encryptedApiKey: "ai_provider.encrypted_api_key",
		apiKeySalt: "ai_provider.api_key_salt",
		apiKeyHash: "ai_provider.api_key_hash",
		apiKeyPreview: "ai_provider.api_key_preview",
		testStatus: "ai_provider.test_status",
		testError: "ai_provider.test_error",
		lastTestedAt: "ai_provider.last_tested_at",
		lastUsedAt: "ai_provider.last_used_at",
		enabled: "ai_provider.enabled",
		isDefault: "ai_provider.is_default",
		createdAt: "ai_provider.created_at",
		updatedAt: "ai_provider.updated_at",
	},
}));
vi.mock("drizzle-orm", () => ({
	and: (...conditions: unknown[]) => ({ type: "and", conditions }),
	asc: (value: unknown) => ({ type: "asc", value }),
	desc: (value: unknown) => ({ type: "desc", value }),
	eq: (left: unknown, right: unknown) => ({ type: "eq", left, right }),
	isNull: (value: unknown) => ({ type: "isNull", value }),
	ne: (left: unknown, right: unknown) => ({ type: "ne", left, right }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ type: "sql", strings: [...strings], values }),
}));
vi.mock("@reactive-resume/env/server", () => ({ env: envMock }));
const quotaMock = vi.hoisted(() => ({ assertWithinQuota: vi.fn(async () => ({})) }));
vi.mock("@careeros/ai-metering", async (original) => ({
	...(await original<typeof import("@careeros/ai-metering")>()),
	assertWithinQuota: quotaMock.assertWithinQuota,
}));
vi.mock("../ai/credentials", () => ({
	assertCredentialEncryptionConfigured: vi.fn(),
	decryptCredential: vi.fn(() => "decrypted-key"),
	encryptCredential: vi.fn(),
}));
vi.mock("@careeros/billing", () => ({
	getEntitlements: vi.fn(async () => ({ features: { platform_ai: true } })),
}));
vi.mock("../ai/service", () => ({ testConnection: vi.fn() }));
vi.mock("../ai/url-policy", () => ({ resolveAiBaseUrl: vi.fn() }));

const { aiProvidersService } = await import("./service");
const { resolveAiBaseUrl } = await import("../ai/url-policy");

function providerRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "provider-1",
		userId: "user-1",
		label: "OpenAI",
		provider: "openai",
		model: "gpt-5-mini",
		baseUrl: null,
		encryptedApiKey: "encrypted-key",
		apiKeySalt: "salt",
		apiKeyHash: "hash",
		apiKeyPreview: "preview",
		testStatus: "success",
		testError: null,
		lastTestedAt: new Date("2026-07-01T00:00:00Z"),
		lastUsedAt: new Date("2026-07-07T00:00:00Z"),
		enabled: true,
		isDefault: false,
		createdAt: new Date("2026-07-01T00:00:00Z"),
		updatedAt: new Date("2026-07-01T00:00:00Z"),
		...overrides,
	};
}

describe("aiProvidersService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		queryState.rows = [];
		queryState.whereArg = undefined;
		queryState.orderByArgs = [];
		queryState.updateRows = undefined;
		queryState.updateWhere = undefined;
	});

	it("prefers the default enabled and tested provider, then the most recently used, then creation order", async () => {
		queryState.rows = [providerRow({ id: "first-created" })];

		await expect(aiProvidersService.getDefaultRunnable({ userId: "user-1" })).resolves.toMatchObject({
			id: "first-created",
			apiKey: "decrypted-key",
		});

		expect(queryState.whereArg).toEqual({
			type: "and",
			conditions: [
				{ type: "eq", left: "ai_provider.user_id", right: "user-1" },
				{ type: "eq", left: "ai_provider.enabled", right: true },
				{ type: "eq", left: "ai_provider.test_status", right: "success" },
				{ type: "ne", left: "ai_provider.id", right: "server-ai:org_test:user-1" },
				// CAREEROS (P3-T03): the platform reference row is never one of the member's own providers
				{ type: "ne", left: "ai_provider.id", right: "platform-ai:org_test:user-1" },
			],
		});
		expect(queryState.orderByArgs).toEqual([
			{ type: "desc", value: "ai_provider.is_default" },
			{
				type: "desc",
				value: {
					type: "sql",
					strings: ["coalesce(", ", '1970-01-01T00:00:00.000Z'::timestamptz)"],
					values: ["ai_provider.last_used_at"],
				},
			},
			{ type: "asc", value: "ai_provider.created_at" },
		]);
		expect(queryMock.limit).toHaveBeenCalledWith(1);
	});

	it("sends a saved key only to the host it was saved for", async () => {
		queryState.rows = [providerRow()];
		vi.mocked(resolveAiBaseUrl).mockReturnValue("https://other.example/v1");
		const owner = { id: "provider-1", userId: "user-1" };

		for (const change of [{ baseURL: "https://other.example/v1" }, { provider: "anthropic" as const }])
			await expect(aiProvidersService.update({ ...owner, ...change })).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: "Enter the API key again to change the provider or base URL.",
			});
		expect(dbMock.update).not.toHaveBeenCalled();

		await expect(
			aiProvidersService.update({ ...owner, baseURL: "https://other.example/v1", apiKey: "new-key" }),
		).resolves.toMatchObject({ id: "provider-1" });
	});

	it("rejects an update if the destination or credential changed after the ownership read", async () => {
		queryState.rows = [providerRow()];
		queryState.updateRows = [];
		await expect(
			aiProvidersService.update({ id: "provider-1", userId: "user-1", apiKey: "new-key" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(queryState.updateWhere).toMatchObject({
			conditions: expect.arrayContaining([
				{ type: "eq", left: "ai_provider.provider", right: "openai" },
				{ type: "isNull", value: "ai_provider.base_url" },
				{ type: "eq", left: "ai_provider.encrypted_api_key", right: "encrypted-key" },
			]),
		});
	});
	it("binds recipient version to owner, provider, model, full URL and encrypted credential revision", async () => {
		queryState.rows = [providerRow()];
		const original = await aiProvidersService.getDefaultRunnable({ userId: "user-1" });
		expect(original?.recipientVersion).toMatch(/^[a-f0-9]{64}$/);
		for (const change of [
			{ id: "other" },
			{ userId: "other" },
			{ provider: "anthropic" },
			{ model: "other" },
			{ baseUrl: "https://other.example/v1" },
			{ encryptedApiKey: "replacement" },
		]) {
			queryState.rows = [providerRow(change)];
			expect((await aiProvidersService.getDefaultRunnable({ userId: "user-1" }))?.recipientVersion).not.toBe(
				original?.recipientVersion,
			);
		}
	});

	// CAREEROS (P3-T03): the operator's server-managed AI is the operator's money, so it is metered like the platform.
	describe("server-managed AI", () => {
		const configure = (model: string) => {
			envMock.AI_PROVIDER = "anthropic";
			envMock.AI_MODEL = model;
			envMock.AI_API_KEY = "operator-key-placeholder";
		};
		afterEach(() => {
			delete envMock.AI_PROVIDER;
			delete envMock.AI_MODEL;
			delete envMock.AI_API_KEY;
		});

		it("is metered as a platform call and checked against the organization's quota", async () => {
			configure("claude-sonnet-5-5");
			for (const resolve of [
				() => aiProvidersService.getRunnableById({ id: "any", userId: "user-1", feature: "resume.improve" }),
				() => aiProvidersService.getDefaultRunnable({ userId: "user-1", feature: "resume.improve" }),
			]) {
				quotaMock.assertWithinQuota.mockClear();
				const runnable = await resolve();
				expect(runnable).toMatchObject({
					managed: true,
					source: "platform",
					metering: { feature: "resume.improve", userId: "user-1", source: "platform" },
				});
				expect(quotaMock.assertWithinQuota).toHaveBeenCalledTimes(1);
			}
		});

		it("is refused at 100% of the allowance", async () => {
			configure("claude-sonnet-5-5");
			quotaMock.assertWithinQuota.mockRejectedValueOnce(
				Object.assign(new Error("quota"), { code: "AI_QUOTA_EXCEEDED" }),
			);
			await expect(
				aiProvidersService.getDefaultRunnable({ userId: "user-1", feature: "agent.turn" }),
			).rejects.toMatchObject({ code: "AI_QUOTA_EXCEEDED" });
		});

		it("is refused when its model has no price, like the platform path", async () => {
			configure("some-unpriced-model");
			await expect(
				aiProvidersService.getDefaultRunnable({ userId: "user-1", feature: "resume.improve" }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});

		it("is refused for a caller that names no feature, so nothing runs unmetered", async () => {
			configure("claude-sonnet-5-5");
			await expect(aiProvidersService.getRunnableById({ id: "any", userId: "user-1" })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		});
	});

	// CAREEROS (P3-T11): the platform provider follows CAREEROS_AI_PLATFORM_PROVIDER.
	describe("platform AI", () => {
		const configure = (values: Record<string, unknown>) => {
			Object.assign(envMock, {
				CAREEROS_AI_MODEL_GENERATION: "claude-sonnet-5-5",
				CAREEROS_AI_MODEL_FAST: "claude-haiku-5-5",
				...values,
			});
		};
		afterEach(() => {
			for (const key of [
				"CAREEROS_AI_PLATFORM_PROVIDER",
				"ANTHROPIC_API_KEY",
				"OPENROUTER_API_KEY",
				"CAREEROS_AI_MODEL_GENERATION",
				"CAREEROS_AI_MODEL_FAST",
			])
				delete envMock[key];
		});

		it("uses anthropic and the canonical model by default", async () => {
			configure({ ANTHROPIC_API_KEY: "ant-key-placeholder" });
			const runnable = await aiProvidersService.getRunnableById({
				id: "platform-ai:org_test:user-1",
				userId: "user-1",
				feature: "resume.improve",
			});
			expect(runnable).toMatchObject({
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				apiKey: "ant-key-placeholder",
				source: "platform",
			});
		});

		it("uses openrouter, its key and the mapped model when selected", async () => {
			configure({
				CAREEROS_AI_PLATFORM_PROVIDER: "openrouter",
				ANTHROPIC_API_KEY: "ant-key-placeholder",
				OPENROUTER_API_KEY: "or-key-placeholder",
			});
			const runnable = await aiProvidersService.getRunnableById({
				id: "platform-ai:org_test:user-1",
				userId: "user-1",
				feature: "resume.improve",
			});
			expect(runnable).toMatchObject({
				provider: "openrouter",
				model: "anthropic/claude-sonnet-5.5",
				apiKey: "or-key-placeholder",
				source: "platform",
				metering: { feature: "resume.improve", userId: "user-1", source: "platform" },
			});
			expect(queryState.insertedRow).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5" });
		});

		it("is refused on openrouter with no OpenRouter key", async () => {
			configure({ CAREEROS_AI_PLATFORM_PROVIDER: "openrouter", ANTHROPIC_API_KEY: "ant-key-placeholder" });
			await expect(
				aiProvidersService.getRunnableById({
					id: "platform-ai:org_test:user-1",
					userId: "user-1",
					feature: "resume.improve",
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});
	});
});
