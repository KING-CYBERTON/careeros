import type { BrandingAsset } from "./assets";
import type { BrandingUpdate } from "./schemas";
import { randomUUID } from "node:crypto";
import { currentHost, requireOrgId, type HostContext } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";
import { enqueueStorageCleanup, runStorageCleanup } from "../storage/cleanup";
import { getStorageService } from "../storage/service";
import { bustPublicBranding, readPublicBrandingCache } from "./cache";

// CAREEROS (P2-T01): organization branding and settings. Every query here runs inside the request's organization
// scope (`protectedProcedure`), so row-level security confines it; the organization id is never taken from the client.

type BrandingRow = typeof schema.organizationBranding.$inferSelect;

/** Where a stored branding asset is served (`apps/server/src/static/branding.ts`). */
export function brandingAssetUrl(organizationId: string, storageKey: string | null): string | null {
	if (!storageKey) return null;
	const filename = storageKey.split("/").pop() ?? "";
	return new URL(`/api/branding-assets/${organizationId}/${filename}`, env.APP_URL).toString();
}

/** Owners and admins manage branding and settings. The role comes from `member`, never from the client. */
export async function requireOrganizationAdmin(userId: string): Promise<string> {
	const organizationId = requireOrgId();
	const [membership] = await db
		.select({ role: schema.member.role })
		.from(schema.member)
		.where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
		.limit(1);
	// Better Auth stores several roles as a comma separated list.
	const roles = membership?.role.split(",").map((role) => role.trim()) ?? [];
	if (!roles.includes("owner") && !roles.includes("admin"))
		throw new ORPCError("FORBIDDEN", { message: "Only an owner or admin of the organization can change this." });
	return organizationId;
}

function toBranding(organizationId: string, row: BrandingRow | undefined) {
	return {
		appName: row?.appName ?? null,
		logoUrl: brandingAssetUrl(organizationId, row?.logoStorageKey ?? null),
		faviconUrl: brandingAssetUrl(organizationId, row?.faviconStorageKey ?? null),
		primaryColor: row?.primaryColor ?? null,
		secondaryColor: row?.secondaryColor ?? null,
		font: (row?.font ?? null) as (typeof schema.BRANDING_FONTS)[number] | null,
		emailFromName: row?.emailFromName ?? null,
		emailReplyTo: row?.emailReplyTo ?? null,
		supportUrl: row?.supportUrl ?? null,
		termsUrl: row?.termsUrl ?? null,
		privacyUrl: row?.privacyUrl ?? null,
		updatedAt: row?.updatedAt ?? new Date(0),
	};
}

export async function getBranding() {
	const organizationId = requireOrgId();
	const [row] = await db
		.select()
		.from(schema.organizationBranding)
		.where(eq(schema.organizationBranding.organizationId, organizationId))
		.limit(1);
	return toBranding(organizationId, row);
}

export async function updateBranding(userId: string, input: BrandingUpdate) {
	const organizationId = await requireOrganizationAdmin(userId);
	const values = {
		...(input.appName !== undefined && { appName: input.appName }),
		...(input.primaryColor !== undefined && { primaryColor: input.primaryColor?.toLowerCase() ?? null }),
		...(input.secondaryColor !== undefined && { secondaryColor: input.secondaryColor?.toLowerCase() ?? null }),
		...(input.font !== undefined && { font: input.font }),
		...(input.emailFromName !== undefined && { emailFromName: input.emailFromName }),
		...(input.emailReplyTo !== undefined && { emailReplyTo: input.emailReplyTo }),
		...(input.supportUrl !== undefined && { supportUrl: input.supportUrl }),
		...(input.termsUrl !== undefined && { termsUrl: input.termsUrl }),
		...(input.privacyUrl !== undefined && { privacyUrl: input.privacyUrl }),
		updatedAt: new Date(),
		updatedBy: userId,
	};
	const [row] = await db
		.insert(schema.organizationBranding)
		.values({ organizationId, ...values })
		.onConflictDoUpdate({ target: schema.organizationBranding.organizationId, set: values })
		.returning();
	// CAREEROS (P2-T02): the app shell caches public branding for 60 s; drop this organization's entry.
	bustPublicBranding(organizationId);
	return toBranding(organizationId, row);
}

type AssetKind = "logo" | "favicon";

/**
 * Stores the new file under `orgs/<org>/branding/`, points the row at it, and queues the previous file for cleanup in
 * the same transaction. A failed database write removes the new file again.
 */
export async function replaceBrandingAsset(userId: string, kind: AssetKind, asset: BrandingAsset) {
	const organizationId = await requireOrganizationAdmin(userId);
	const column = kind === "logo" ? "logoStorageKey" : "faviconStorageKey";
	const key = `orgs/${organizationId}/branding/${kind}-${randomUUID()}.${asset.extension}`;
	const storage = getStorageService();
	await storage.write({ key, data: asset.data, contentType: asset.contentType });
	let previous: string | null = null;
	try {
		previous = await db.transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(schema.organizationBranding)
				.where(eq(schema.organizationBranding.organizationId, organizationId))
				.limit(1)
				.for("update");
			const values = { [column]: key, updatedAt: new Date(), updatedBy: userId };
			await tx
				.insert(schema.organizationBranding)
				.values({ organizationId, ...values })
				.onConflictDoUpdate({ target: schema.organizationBranding.organizationId, set: values });
			const old = current?.[column] ?? null;
			// The work is owned by the organization, so it outlives the account of whoever uploaded the file.
			if (old) await enqueueStorageCleanup(tx, organizationId, [old]);
			return old;
		});
	} catch (error) {
		await storage.delete(key).catch(() => false);
		throw error;
	}
	bustPublicBranding(organizationId);
	if (previous) await runStorageCleanup({ ownerId: organizationId, storageKeys: [previous] }).catch(() => undefined);
	return { url: brandingAssetUrl(organizationId, key) ?? "", contentType: asset.contentType };
}

/**
 * CAREEROS (P2-T07, Q77): removes the logo or favicon. The key is nulled and the file queued for cleanup in one
 * transaction, as a replacement does. NOT_FOUND when the organization has none to remove.
 */
export async function removeBrandingAsset(userId: string, kind: AssetKind) {
	const organizationId = await requireOrganizationAdmin(userId);
	const column = kind === "logo" ? "logoStorageKey" : "faviconStorageKey";
	const { previous, row } = await db.transaction(async (tx) => {
		const [current] = await tx
			.select()
			.from(schema.organizationBranding)
			.where(eq(schema.organizationBranding.organizationId, organizationId))
			.limit(1)
			.for("update");
		const old = current?.[column] ?? null;
		if (!old) throw new ORPCError("NOT_FOUND", { message: `This organization has no ${kind} to remove.` });
		const [updated] = await tx
			.update(schema.organizationBranding)
			.set({ [column]: null, updatedAt: new Date(), updatedBy: userId })
			.where(eq(schema.organizationBranding.organizationId, organizationId))
			.returning();
		await enqueueStorageCleanup(tx, organizationId, [old]);
		return { previous: old, row: updated };
	});
	bustPublicBranding(organizationId);
	await runStorageCleanup({ ownerId: organizationId, storageKeys: [previous] }).catch(() => undefined);
	return toBranding(organizationId, row);
}

export async function getSettings() {
	const organizationId = requireOrgId();
	const [row] = await db
		.select()
		.from(schema.organizationSettings)
		.where(eq(schema.organizationSettings.organizationId, organizationId))
		.limit(1);
	return { openSignup: row?.openSignup ?? false, updatedAt: row?.updatedAt ?? new Date(0) };
}

export async function updateSettings(userId: string, input: { openSignup?: boolean | undefined }) {
	const organizationId = await requireOrganizationAdmin(userId);
	const values = { ...(input.openSignup !== undefined && { openSignup: input.openSignup }), updatedAt: new Date() };
	const [row] = await db
		.insert(schema.organizationSettings)
		.values({ organizationId, ...values })
		.onConflictDoUpdate({ target: schema.organizationSettings.organizationId, set: values })
		.returning();
	return { openSignup: row?.openSignup ?? false, updatedAt: row?.updatedAt ?? values.updatedAt };
}

type PublicRow = {
	organization_id: string;
	slug: string;
	app_name: string | null;
	logo_storage_key: string | null;
	favicon_storage_key: string | null;
	primary_color: string | null;
	secondary_color: string | null;
	font: (typeof schema.BRANDING_FONTS)[number] | null;
	support_url: string | null;
	terms_url: string | null;
	privacy_url: string | null;
};

function toPublic(row: PublicRow) {
	return {
		organizationId: row.organization_id,
		slug: row.slug,
		appName: row.app_name,
		logoUrl: brandingAssetUrl(row.organization_id, row.logo_storage_key),
		faviconUrl: brandingAssetUrl(row.organization_id, row.favicon_storage_key),
		primaryColor: row.primary_color,
		secondaryColor: row.secondary_color,
		font: row.font,
		supportUrl: row.support_url,
		termsUrl: row.terms_url,
		privacyUrl: row.privacy_url,
	};
}

/** The public fields of an organization, by slug, without a session. `null` for an unknown organization. */
export async function getPublicBrandingBySlug(slug: string) {
	const { rows } = await db.execute<PublicRow>(sql`select * from careeros_public_branding_by_slug(${slug}::text)`);
	return rows[0] ? toPublic(rows[0]) : null;
}

/** The public fields of an organization, by id, without a session. `null` for an unknown organization. */
export async function getPublicBrandingByOrganizationId(organizationId: string) {
	const { rows } = await db.execute<PublicRow>(sql`select * from careeros_public_branding(${organizationId}::text)`);
	return rows[0] ? toPublic(rows[0]) : null;
}

/**
 * CAREEROS (P2-T02): `getPublicBrandingByOrganizationId` through a 60 s in-process cache, for the app shell. The id must
 * come from the request's resolved host, never from the client. `updateBranding` and uploads bust the entry.
 */
export function getCachedPublicBranding(organizationId: string) {
	return readPublicBrandingCache(organizationId, () => getPublicBrandingByOrganizationId(organizationId));
}

export type PublicBranding = NonNullable<Awaited<ReturnType<typeof getPublicBrandingBySlug>>>;

/**
 * CAREEROS (P2-T07, Q95): the public branding of the request's host, for a client that has no session yet (the mobile
 * sign-in screen). The organization comes from the resolved host, never from the caller. The platform host and any
 * host that is not an organization's answer with the platform default (every field null).
 */
export async function getPublicBrandingForHost(host: HostContext | undefined = currentHost()) {
	const empty = {
		organizationId: null,
		slug: null,
		appName: null,
		logoUrl: null,
		faviconUrl: null,
		primaryColor: null,
		secondaryColor: null,
		font: null,
		supportUrl: null,
		termsUrl: null,
		privacyUrl: null,
	};
	if (host?.kind !== "org") return empty;
	return (await getCachedPublicBranding(host.organizationId)) ?? empty;
}

/**
 * The stored asset behind a public branding URL, or `null`. Only the file the branding currently points at is public:
 * a replaced file stops serving before its cleanup runs.
 */
export async function getPublicBrandingAsset(organizationId: string, filename: string) {
	const { rows } = await db.execute<PublicRow>(sql`select * from careeros_public_branding(${organizationId}::text)`);
	const row = rows[0];
	const wanted = `orgs/${organizationId}/branding/${filename}`;
	return [row?.logo_storage_key, row?.favicon_storage_key].find((candidate) => candidate === wanted) ?? null;
}
