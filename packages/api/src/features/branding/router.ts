import { ORPCError } from "@orpc/server";
import z from "zod";
import { protectedProcedure, publicProcedure } from "../../context";
import { accountRateLimit, storageUploadRateLimit } from "../../middleware/rate-limit";
import { validateFavicon, validateLogo } from "./assets";
import { brandingPublicRateLimit } from "./rate-limit";
import {
	brandingSchema,
	brandingUpdateSchema,
	faviconUploadSchema,
	hostBrandingSchema,
	logoUploadSchema,
	publicBrandingSchema,
	publicBySlugInput,
	settingsSchema,
	settingsUpdateSchema,
	uploadResultSchema,
} from "./schemas";
import {
	getBranding,
	getPublicBrandingBySlug,
	getPublicBrandingForHost,
	getSettings,
	removeBrandingAsset,
	requireOrganizationAdmin,
	replaceBrandingAsset,
	updateBranding,
	updateSettings,
} from "./service";

const route = { tags: ["Branding"] };
const forbidden = { FORBIDDEN: { status: 403, message: "Only an owner or admin of the organization can do this." } };

export const brandingRouter = {
	get: protectedProcedure
		.route({
			...route,
			method: "GET",
			path: "/branding",
			operationId: "getBranding",
			summary: "Get the organization's branding",
			description:
				"Returns the current organization's branding: name, logo, favicon, colours, font and legal links. A null field uses the platform default. Any member can read it. Requires authentication.",
		})
		.input(z.object({}).optional())
		.output(brandingSchema)
		.handler(() => getBranding()),

	update: protectedProcedure
		.route({
			...route,
			method: "PATCH",
			path: "/branding",
			operationId: "updateBranding",
			summary: "Update the organization's branding",
			description:
				"Changes the given branding fields of the current organization; send null to reset one to the platform default. Colours are #rrggbb, links are https. Only an owner or admin can do this. Requires authentication.",
		})
		.input(brandingUpdateSchema)
		.use(accountRateLimit)
		.errors(forbidden)
		.output(brandingSchema)
		.handler(({ context, input }) => updateBranding(context.user.id, input)),

	uploadLogo: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/branding/logo",
			operationId: "uploadBrandingLogo",
			summary: "Upload the organization's logo",
			description:
				"Multipart upload of a PNG, SVG or WebP logo, up to 512 KB. SVG files are sanitized; ones with scripts or external references are refused. Replaces the previous logo. Only an owner or admin can do this. Requires authentication.",
		})
		.input(logoUploadSchema)
		.use(storageUploadRateLimit)
		.errors(forbidden)
		.output(uploadResultSchema)
		.handler(async ({ context, input }) => {
			// Check the role before reading the file, so a member cannot make the server decode uploads.
			await requireOrganizationAdmin(context.user.id);
			return replaceBrandingAsset(context.user.id, "logo", await validateLogo(input.file));
		}),

	uploadFavicon: protectedProcedure
		.route({
			...route,
			method: "POST",
			path: "/branding/favicon",
			operationId: "uploadBrandingFavicon",
			summary: "Upload the organization's favicon",
			description:
				"Multipart upload of a PNG or ICO favicon, up to 128 KB. Replaces the previous favicon. Only an owner or admin can do this. Requires authentication.",
		})
		.input(faviconUploadSchema)
		.use(storageUploadRateLimit)
		.errors(forbidden)
		.output(uploadResultSchema)
		.handler(async ({ context, input }) => {
			await requireOrganizationAdmin(context.user.id);
			return replaceBrandingAsset(context.user.id, "favicon", await validateFavicon(input.file));
		}),

	// CAREEROS (P2-T07, Q77): remove the logo or favicon.
	deleteLogo: protectedProcedure
		.route({
			...route,
			method: "DELETE",
			path: "/branding/logo",
			operationId: "deleteBrandingLogo",
			summary: "Remove the organization's logo",
			description:
				"Removes the current logo, so the platform default shows again, and queues the file for deletion. NOT_FOUND when there is none. Only an owner or admin can do this. Requires authentication.",
		})
		.input(z.object({}).optional())
		.use(accountRateLimit)
		.errors({ ...forbidden, NOT_FOUND: { status: 404, message: "The organization has no logo." } })
		.output(brandingSchema)
		.handler(({ context }) => removeBrandingAsset(context.user.id, "logo")),

	deleteFavicon: protectedProcedure
		.route({
			...route,
			method: "DELETE",
			path: "/branding/favicon",
			operationId: "deleteBrandingFavicon",
			summary: "Remove the organization's favicon",
			description:
				"Removes the current favicon, so the platform default shows again, and queues the file for deletion. NOT_FOUND when there is none. Only an owner or admin can do this. Requires authentication.",
		})
		.input(z.object({}).optional())
		.use(accountRateLimit)
		.errors({ ...forbidden, NOT_FOUND: { status: 404, message: "The organization has no favicon." } })
		.output(brandingSchema)
		.handler(({ context }) => removeBrandingAsset(context.user.id, "favicon")),

	// CAREEROS (P2-T07, Q95): the branding of the address the request came to, for the mobile sign-in screen.
	publicForHost: publicProcedure
		.route({
			...route,
			method: "GET",
			path: "/branding/host",
			operationId: "getPublicBrandingForHost",
			summary: "Get the public branding of this address",
			description:
				"Returns the branding anyone may see before signing in for the address the request was sent to: the organization's on its own address, the platform default (every field null) elsewhere. Never returns the sender name or settings. No authentication required.",
		})
		.input(z.object({}).optional())
		.use(brandingPublicRateLimit)
		.output(hostBrandingSchema)
		.handler(({ context }) => getPublicBrandingForHost(context.host)),

	publicBySlug: publicProcedure
		.route({
			...route,
			method: "GET",
			path: "/branding/public/{slug}",
			operationId: "getPublicBranding",
			summary: "Get an organization's public branding",
			description:
				"Returns the branding anyone may see before signing in: name, logo and favicon addresses, colours, font and legal links, by organization slug. Never returns the sender name or settings. No authentication required.",
		})
		.input(publicBySlugInput)
		.use(brandingPublicRateLimit)
		.errors({ NOT_FOUND: { status: 404, message: "No organization has this slug." } })
		.output(publicBrandingSchema)
		.handler(async ({ input }) => {
			const branding = await getPublicBrandingBySlug(input.slug);
			if (!branding) throw new ORPCError("NOT_FOUND");
			return branding;
		}),
};

export const settingsRouter = {
	get: protectedProcedure
		.route({
			...route,
			tags: ["Organization"],
			method: "GET",
			path: "/organization/settings",
			operationId: "getOrganizationSettings",
			summary: "Get the organization's settings",
			description:
				"Returns the current organization's settings. Only an owner or admin can read them. Requires authentication.",
		})
		.input(z.object({}).optional())
		.errors(forbidden)
		.output(settingsSchema)
		.handler(async ({ context }) => {
			await requireOrganizationAdmin(context.user.id);
			return getSettings();
		}),

	update: protectedProcedure
		.route({
			...route,
			tags: ["Organization"],
			method: "PATCH",
			path: "/organization/settings",
			operationId: "updateOrganizationSettings",
			summary: "Update the organization's settings",
			description:
				"Changes the current organization's settings. Only an owner or admin can do this. Requires authentication.",
		})
		.input(settingsUpdateSchema)
		.use(accountRateLimit)
		.errors(forbidden)
		.output(settingsSchema)
		.handler(({ context, input }) => updateSettings(context.user.id, input)),
};
