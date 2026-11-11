import type { AIProvider } from "@reactive-resume/ai/types";
import type { DbOrTx } from "@reactive-resume/db/client";
import { createHmac } from "node:crypto";
// CAREEROS (P3-T03): the platform Claude provider and the metering of every call
import {
	AiModelNotPricedError,
	assertWithinQuota,
	priceFor,
	type AiFeature,
	type Metering,
} from "@careeros/ai-metering";
// CAREEROS: saved connections belong to an organization; writers set it from the active scope (P1-T08)
import { requireOrgId } from "@careeros/tenancy";
import { ORPCError } from "@orpc/client";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { aiProviderSchema } from "@reactive-resume/ai/types";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";
import { assertCredentialEncryptionConfigured, decryptCredential, encryptCredential } from "../ai/credentials";
import {
	isPlatformProviderId,
	PLATFORM_PROVIDER_LABEL,
	platformAiAvailable,
	platformApiKey,
	platformModelFor,
	platformProvider,
	platformProviderId,
} from "../ai/platform";
import { testConnection } from "../ai/service";
import { resolveAiBaseUrl } from "../ai/url-policy";

type AiProviderRecord = typeof schema.aiProvider.$inferSelect;

export type AiProviderResponse = {
	managed: boolean;
	/** CAREEROS (P3-T03): the read-only "Included with your plan" entry. It has no key, and nothing in it can be edited. */
	platform: boolean;
	id: string;
	label: string;
	provider: AIProvider;
	model: string;
	baseURL: string | null;
	enabled: boolean;
	isDefault: boolean;
	testStatus: string;
	testError: string | null;
	apiKeyPreview: string;
	apiKeyFingerprint: string;
	recipientVersion: string;
	lastTestedAt: Date | null;
	lastUsedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

type CreateAiProviderInput = {
	userId: string;
	label: string;
	provider: AIProvider;
	model: string;
	baseURL?: string | null;
	apiKey: string;
};

type UpdateAiProviderInput = {
	id: string;
	userId: string;
	label?: string;
	provider?: AIProvider;
	model?: string;
	baseURL?: string | null;
	apiKey?: string;
	enabled?: boolean;
};

/** Stable across tests and usage; credential replacement requires fresh recipient approval. */
function recipientVersion(row: AiProviderRecord, credentialRevision = row.encryptedApiKey) {
	return createHmac("sha256", env.AUTH_SECRET)
		.update(
			JSON.stringify(["ai-recipient-v1", row.userId, row.id, row.provider, row.model, row.baseUrl, credentialRevision]),
		)
		.digest("hex");
}

function toResponse(row: AiProviderRecord): AiProviderResponse {
	const provider = aiProviderSchema.parse(row.provider);

	return {
		managed: row.id === serverProviderId(row.organizationId, row.userId),
		platform: isPlatformProviderId(row.id),
		id: row.id,
		label: row.label,
		provider,
		model: row.model,
		baseURL: row.baseUrl,
		enabled: row.enabled,
		isDefault: row.isDefault,
		testStatus: row.testStatus,
		testError: row.testError,
		apiKeyPreview: row.apiKeyPreview,
		// The hash identifies the key without revealing it; the ciphertext and salt never leave the server.
		apiKeyFingerprint: row.apiKeyHash,
		recipientVersion: recipientVersion(row),
		lastTestedAt: row.lastTestedAt,
		lastUsedAt: row.lastUsedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function normalizeBaseUrl(input: { provider: AIProvider; baseURL?: string | null }) {
	const trimmed = input.baseURL?.trim() ?? "";
	if (!trimmed) return null;

	return resolveAiBaseUrl({ provider: input.provider, baseURL: trimmed });
}

async function getOwnedProvider(input: { id: string; userId: string }) {
	if (input.id === serverProviderId(requireOrgId(), input.userId) || isPlatformProviderId(input.id))
		throw new ORPCError("NOT_FOUND");
	const [provider] = await db
		.select()
		.from(schema.aiProvider)
		.where(and(eq(schema.aiProvider.id, input.id), eq(schema.aiProvider.userId, input.userId)))
		.limit(1);

	if (!provider) throw new ORPCError("NOT_FOUND");

	return provider;
}

// CAREEROS (P1-T08): the server-managed connection is per organization, because ids are unique across all of them.
const serverProviderId = (organizationId: string, userId: string) => `server-ai:${organizationId}:${userId}`;

/**
 * How a connection is picked when nobody chose one: the default, then the most recently used, then the oldest. Lists
 * use the same order, so the first usable connection on screen is the one the server uses.
 */
const automaticOrder = [
	desc(schema.aiProvider.isDefault),
	desc(sql<Date>`coalesce(${schema.aiProvider.lastUsedAt}, '1970-01-01T00:00:00.000Z'::timestamptz)`),
	asc(schema.aiProvider.createdAt),
];

function assertPersonalProvidersAllowed() {
	if (env.AI_PROVIDER)
		throw new ORPCError("FORBIDDEN", {
			message: "AI is set up by the server administrator and can't be changed here.",
		});
}

/** A persisted reference keeps Assistant thread foreign keys valid; server credentials stay in the environment. */
async function serverProvider(userId: string) {
	if (!env.AI_PROVIDER || !env.AI_MODEL) return null;
	const apiKey = env.AI_API_KEY ?? "";
	const organizationId = requireOrgId();
	const values = {
		organizationId,
		userId,
		label: "Server AI",
		provider: env.AI_PROVIDER,
		model: env.AI_MODEL,
		baseUrl: env.AI_BASE_URL ?? null,
		enabled: true,
		isDefault: true,
		testStatus: "success",
		encryptedApiKey: "",
		apiKeySalt: "",
		apiKeyHash: "",
		apiKeyPreview: "",
	};
	const [row] = await db
		.insert(schema.aiProvider)
		.values({ id: serverProviderId(organizationId, userId), ...values })
		.onConflictDoUpdate({ target: schema.aiProvider.id, set: values })
		.returning();
	if (!row) throw new Error("SERVER_AI_PROVIDER_UNAVAILABLE");
	// Environment settings and key are captured together before the database await.
	return {
		...toResponse(row),
		recipientVersion: recipientVersion(row, apiKey),
		apiKey,
		baseURL: values.baseUrl ?? "",
	};
}

/** CAREEROS (P3-T03): what a call site needs to meter the call, next to the runnable provider's own fields. */
function withMetering<T extends object>(
	runnable: T,
	input: { feature?: AiFeature | undefined; userId: string; source: Metering["source"] },
): T & { source: Metering["source"]; metering: Metering | undefined } {
	return {
		...runnable,
		source: input.source,
		metering: input.feature ? { feature: input.feature, userId: input.userId, source: input.source } : undefined,
	};
}

/**
 * CAREEROS (P3-T03): the reference row of the platform provider. Assistant threads and schedules point at an
 * `ai_provider` row by foreign key, so one exists, like the server-managed one. It holds no key: the key stays in the
 * environment and reaches only `getModel`.
 */
async function platformReference(userId: string) {
	const organizationId = requireOrgId();
	const values = {
		organizationId,
		userId,
		label: PLATFORM_PROVIDER_LABEL,
		provider: platformProvider(),
		model: platformModelFor("agent.turn"),
		baseUrl: null,
		enabled: true,
		isDefault: false,
		testStatus: "success",
		encryptedApiKey: "",
		apiKeySalt: "",
		apiKeyHash: "",
		apiKeyPreview: "",
	};
	const [row] = await db
		.insert(schema.aiProvider)
		.values({ id: platformProviderId(organizationId, userId), ...values })
		.onConflictDoUpdate({ target: schema.aiProvider.id, set: values })
		.returning();
	if (!row) throw new Error("PLATFORM_AI_PROVIDER_UNAVAILABLE");
	return { ...toResponse(row), recipientVersion: recipientVersion(row, "platform") };
}

/** The platform entry for the list: nothing secret, nothing editable. Null when platform AI does not apply. */
async function platformEntry(userId: string) {
	if (!(await platformAiAvailable(requireOrgId()))) return null;
	return platformReference(userId);
}

/**
 * The platform provider as a runnable connection for one feature (the fast model for classification and extraction),
 * after the quota check. Refused when the plan has no platform AI or the allowance is used up.
 */
async function platformRunnable(userId: string, feature: AiFeature | undefined) {
	if (!feature)
		throw new ORPCError("BAD_REQUEST", { message: "This feature can't use the AI included with your plan." });
	const organizationId = requireOrgId();
	if (!(await platformAiAvailable(organizationId)))
		throw new ORPCError("BAD_REQUEST", { message: "AI isn't included with your organization's plan." });
	await assertWithinQuota(organizationId);
	const reference = await platformReference(userId);
	return withMetering(
		{ ...reference, model: platformModelFor(feature), apiKey: platformApiKey(), baseURL: "" },
		{ feature, userId, source: "platform" },
	);
}

/**
 * The operator's server-managed AI (the `AI_PROVIDER` env path). In CareerOS that key is the operator's money, so it is
 * metered like the platform provider: priced (an unpriced model is refused), counted against the organization's quota
 * and refused at 100%. It needs a feature to be metered under, so a caller without one cannot use it.
 */
async function serverRunnable<T extends { model: string }>(
	global: T,
	input: { userId: string; feature?: AiFeature | undefined },
) {
	if (!input.feature)
		throw new ORPCError("BAD_REQUEST", { message: "This feature can't use the AI set up by your server." });
	try {
		priceFor(global.model);
	} catch (error) {
		if (error instanceof AiModelNotPricedError)
			throw new ORPCError("BAD_REQUEST", {
				message: "The AI model set up by your server has no price, so it can't be used.",
			});
		throw error;
	}
	await assertWithinQuota(requireOrgId());
	return withMetering(global, { ...input, source: "platform" });
}

export const aiProvidersService = {
	list: async (input: { userId: string }) => {
		const global = await serverProvider(input.userId);
		if (global) {
			const { apiKey: _apiKey, ...response } = global;
			return [response];
		}
		// CAREEROS (P3-T03): the platform entry needs no ENCRYPTION_SECRET; the member's own providers do.
		const included = await platformEntry(input.userId);
		if (!included) assertCredentialEncryptionConfigured();
		else if (!env.ENCRYPTION_SECRET?.trim()) return [included];

		const providers = await db
			.select()
			.from(schema.aiProvider)
			.where(
				and(
					eq(schema.aiProvider.userId, input.userId),
					ne(schema.aiProvider.id, serverProviderId(requireOrgId(), input.userId)),
					// CAREEROS (P3-T03): the platform reference row is listed separately, after these
					ne(schema.aiProvider.id, platformProviderId(requireOrgId(), input.userId)),
				),
			)
			.orderBy(...automaticOrder);

		// CAREEROS (P3-T03): the platform entry comes last, so the member's own providers stay the default.
		return [...providers.map(toResponse), ...(included ? [included] : [])];
	},

	/** Checks availability of an already captured recipient without resolving new settings or credentials. */
	assertAvailable: async (input: { id: string; userId: string }, reader: DbOrTx) => {
		if (input.id === serverProviderId(requireOrgId(), input.userId)) {
			if (!env.AI_PROVIDER || !env.AI_MODEL)
				throw new ORPCError("BAD_REQUEST", { message: "AI is no longer configured on this server." });
			return;
		}
		// CAREEROS (P3-T03): the platform provider is available while the plan includes it
		if (input.id === platformProviderId(requireOrgId(), input.userId)) {
			if (!(await platformAiAvailable(requireOrgId())))
				throw new ORPCError("BAD_REQUEST", { message: "AI isn't included with your organization's plan." });
			return;
		}
		const [provider] = await reader
			.select({ enabled: schema.aiProvider.enabled, testStatus: schema.aiProvider.testStatus })
			.from(schema.aiProvider)
			.where(and(eq(schema.aiProvider.id, input.id), eq(schema.aiProvider.userId, input.userId)))
			.for("share");
		if (!provider) throw new ORPCError("NOT_FOUND");
		if (!provider.enabled || provider.testStatus !== "success")
			throw new ORPCError("BAD_REQUEST", { message: "Test and turn on this AI provider before using it." });
	},

	getRunnableById: async (input: { id: string; userId: string; feature?: AiFeature | undefined }) => {
		const global = await serverProvider(input.userId);
		if (global) return serverRunnable(global, input);
		if (input.id === platformProviderId(requireOrgId(), input.userId))
			return platformRunnable(input.userId, input.feature);
		assertCredentialEncryptionConfigured();

		const provider = await getOwnedProvider(input);
		if (!provider.enabled || provider.testStatus !== "success") {
			throw new ORPCError("BAD_REQUEST", { message: "Test and turn on this AI provider before using it." });
		}

		return withMetering(
			{
				...toResponse(provider),
				apiKey: decryptCredential(provider.encryptedApiKey),
				baseURL: provider.baseUrl ?? "",
			},
			{ ...input, source: "own_key" },
		);
	},

	/**
	 * CAREEROS (P5-T03): the platform provider and nothing else, after the plan and quota checks. A caller that must never
	 * touch a member's saved key (the Job Clipper's "Tidy with AI", which runs on a clipper token) uses this instead of
	 * `getDefaultRunnable`, which falls back to the member's own providers and the server-managed AI.
	 */
	getPlatformRunnable: (input: { userId: string; feature: AiFeature }) => platformRunnable(input.userId, input.feature),

	getDefaultRunnable: async (input: { userId: string; feature?: AiFeature | undefined }) => {
		const global = await serverProvider(input.userId);
		if (global) return serverRunnable(global, input);
		// CAREEROS (P3-T03): the platform is only a fallback for a member with no provider of their own. It needs no
		// ENCRYPTION_SECRET, so a server without one can still serve the included AI.
		if (!env.ENCRYPTION_SECRET?.trim() && input.feature && (await platformAiAvailable(requireOrgId())))
			return platformRunnable(input.userId, input.feature);
		assertCredentialEncryptionConfigured();

		const [provider] = await db
			.select()
			.from(schema.aiProvider)
			.where(
				and(
					eq(schema.aiProvider.userId, input.userId),
					eq(schema.aiProvider.enabled, true),
					eq(schema.aiProvider.testStatus, "success"),
					ne(schema.aiProvider.id, serverProviderId(requireOrgId(), input.userId)),
					ne(schema.aiProvider.id, platformProviderId(requireOrgId(), input.userId)),
				),
			)
			.orderBy(...automaticOrder)
			.limit(1);

		if (provider)
			return withMetering(
				{
					...toResponse(provider),
					apiKey: decryptCredential(provider.encryptedApiKey),
					baseURL: provider.baseUrl ?? "",
				},
				{ ...input, source: "own_key" },
			);
		if (input.feature && (await platformAiAvailable(requireOrgId())))
			return platformRunnable(input.userId, input.feature);
		return null;
	},

	create: async (input: CreateAiProviderInput) => {
		assertPersonalProvidersAllowed();
		assertCredentialEncryptionConfigured();

		const encrypted = encryptCredential(input.apiKey.trim());
		const [provider] = await db
			.insert(schema.aiProvider)
			.values({
				// CAREEROS (P1-T08): tenant column
				organizationId: requireOrgId(),
				userId: input.userId,
				label: input.label.trim(),
				provider: input.provider,
				model: input.model.trim(),
				baseUrl: normalizeBaseUrl(input),
				...encrypted,
			})
			.returning();

		if (!provider) throw new Error("AI_PROVIDER_CREATE_FAILED");

		return toResponse(provider);
	},

	update: async (input: UpdateAiProviderInput) => {
		assertPersonalProvidersAllowed();
		assertCredentialEncryptionConfigured();

		const existing = await getOwnedProvider(input);
		const provider = input.provider ?? aiProviderSchema.parse(existing.provider);
		const nextApiKey = input.apiKey?.trim();
		const nextBaseUrl =
			input.baseURL !== undefined ? normalizeBaseUrl({ provider, baseURL: input.baseURL }) : existing.baseUrl;
		const providerChanged = input.provider !== undefined && input.provider !== existing.provider;
		const modelChanged = input.model !== undefined && input.model.trim() !== existing.model;
		const baseUrlChanged = input.baseURL !== undefined && nextBaseUrl !== existing.baseUrl;
		const hostChanged = providerChanged || baseUrlChanged;

		// The saved key only goes where it was saved for: a new provider or address needs the key sent with it.
		if (hostChanged && nextApiKey === undefined) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Enter the API key again to change the provider or base URL.",
			});
		}

		// On a new host the key is replaced even when empty (Ollama runs without one).
		const encrypted = nextApiKey || hostChanged ? encryptCredential(nextApiKey ?? "") : {};
		const credentialChanged = !!nextApiKey;
		const runtimeChanged = credentialChanged || providerChanged || modelChanged || baseUrlChanged;

		if (input.enabled === true && existing.testStatus !== "success" && !runtimeChanged) {
			throw new ORPCError("BAD_REQUEST", { message: "Test this AI provider before turning it on." });
		}

		const [updated] = await db
			.update(schema.aiProvider)
			.set({
				...(input.label !== undefined ? { label: input.label.trim() } : {}),
				...(input.provider !== undefined ? { provider: input.provider } : {}),
				...(input.model !== undefined ? { model: input.model.trim() } : {}),
				...(input.baseURL !== undefined ? { baseUrl: nextBaseUrl } : {}),
				...(input.enabled !== undefined && !runtimeChanged ? { enabled: input.enabled } : {}),
				...(runtimeChanged ? { enabled: false, testStatus: "untested", lastTestedAt: null, testError: null } : {}),
				...encrypted,
			})
			.where(
				and(
					eq(schema.aiProvider.id, input.id),
					eq(schema.aiProvider.userId, input.userId),
					eq(schema.aiProvider.provider, existing.provider),
					eq(schema.aiProvider.model, existing.model),
					existing.baseUrl === null
						? isNull(schema.aiProvider.baseUrl)
						: eq(schema.aiProvider.baseUrl, existing.baseUrl),
					eq(schema.aiProvider.encryptedApiKey, existing.encryptedApiKey),
					eq(schema.aiProvider.testStatus, existing.testStatus),
				),
			)
			.returning();

		if (!updated) throw new ORPCError("CONFLICT", { message: "The provider changed. Reload it before saving again." });
		return toResponse(updated);
	},

	delete: async (input: { id: string; userId: string }) => {
		assertPersonalProvidersAllowed();
		assertCredentialEncryptionConfigured();
		// CAREEROS (P3-T03): the platform reference row is not the member's to remove
		if (isPlatformProviderId(input.id)) throw new ORPCError("NOT_FOUND");

		await db
			.delete(schema.aiProvider)
			.where(and(eq(schema.aiProvider.id, input.id), eq(schema.aiProvider.userId, input.userId)));
	},

	test: async (input: { id: string; userId: string }) => {
		assertPersonalProvidersAllowed();
		assertCredentialEncryptionConfigured();

		const provider = await getOwnedProvider(input);
		const parsedProvider = aiProviderSchema.parse(provider.provider);
		const apiKey = decryptCredential(provider.encryptedApiKey);
		// A result applies only to the settings it tested: an edit made while the request ran resets the connection
		// to untested, and a late result must not mark the new settings as working.
		const tested = and(
			eq(schema.aiProvider.id, input.id),
			eq(schema.aiProvider.userId, input.userId),
			eq(schema.aiProvider.provider, provider.provider),
			eq(schema.aiProvider.model, provider.model),
			provider.baseUrl === null ? isNull(schema.aiProvider.baseUrl) : eq(schema.aiProvider.baseUrl, provider.baseUrl),
			eq(schema.aiProvider.encryptedApiKey, provider.encryptedApiKey),
		);
		const changed = () =>
			new ORPCError("CONFLICT", { message: "The provider changed during the test. Test it again." });

		try {
			const result = await testConnection({
				provider: parsedProvider,
				model: provider.model,
				apiKey,
				baseURL: provider.baseUrl ?? "",
			});

			// A provider that answers "no" is a completed test, not a failed request: it comes back as
			// data so the client can show why, instead of a generic transport error.
			const [updated] = await db
				.update(schema.aiProvider)
				.set({
					enabled: result.ok,
					testStatus: result.ok ? "success" : "failure",
					testError: result.ok ? null : result.message,
					lastTestedAt: new Date(),
				})
				.where(tested)
				.returning();

			if (!updated) throw changed();
			return toResponse(updated);
		} catch (error) {
			if (error instanceof ORPCError && error.code === "CONFLICT") throw error;
			// Only unexpected failures reach here now: provider-side outcomes come back as data above.
			await db
				.update(schema.aiProvider)
				.set({
					enabled: false,
					testStatus: "failure",
					testError: error instanceof Error ? error.message : "Failed to test provider.",
					lastTestedAt: new Date(),
				})
				.where(tested);

			throw error;
		}
	},

	/** Makes one tested, switched-on connection the default; the previous default stops being one. */
	setDefault: async (input: { id: string; userId: string }) => {
		assertPersonalProvidersAllowed();
		const provider = await getOwnedProvider(input);
		if (!provider.enabled || provider.testStatus !== "success")
			throw new ORPCError("BAD_REQUEST", {
				message: "Test and turn on this provider before making it the default.",
			});
		const [updated] = await db.transaction(async (tx) => {
			await tx
				.update(schema.aiProvider)
				.set({ isDefault: false })
				.where(
					and(
						eq(schema.aiProvider.organizationId, requireOrgId()),
						eq(schema.aiProvider.userId, input.userId),
						eq(schema.aiProvider.isDefault, true),
					),
				);
			return tx
				.update(schema.aiProvider)
				.set({ isDefault: true })
				.where(and(eq(schema.aiProvider.id, input.id), eq(schema.aiProvider.userId, input.userId)))
				.returning();
		});
		if (!updated) throw new ORPCError("NOT_FOUND");
		return toResponse(updated);
	},

	markUsed: async (input: { id: string; userId: string }) => {
		await db
			.update(schema.aiProvider)
			.set({ lastUsedAt: new Date() })
			.where(and(eq(schema.aiProvider.id, input.id), eq(schema.aiProvider.userId, input.userId)));
	},
};
