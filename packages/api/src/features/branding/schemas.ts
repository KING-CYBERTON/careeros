import z from "zod";
import { BRANDING_FONTS } from "@reactive-resume/db/schema";
import { isSingleEmailAddress } from "@reactive-resume/utils/brand";

// CAREEROS (P2-T01). The database CHECK constraints are the last line; these schemas give the caller a clear error first.

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
// eslint-disable-next-line no-control-regex -- header injection guard: the name goes into a From header.
const CONTROL_OR_ANGLE = /[\u0000-\u001f\u007f<>]/;

const colorSchema = z.string().regex(HEX_COLOR, "Use a colour like #1a2b3c.");

/** An https URL without credentials. The `https://` prefix matches the database CHECK constraint. */
export function isHttpsUrl(value: string): boolean {
	if (!value.startsWith("https://")) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname !== "";
	} catch {
		return false;
	}
}

const httpsUrlSchema = z.string().max(2048).refine(isHttpsUrl, "Use a full https:// address.");

const text = (max: number) => z.string().trim().min(1).max(max);

export const brandingFontSchema = z.enum(BRANDING_FONTS);

/** What anyone can see about an organization before signing in. Never `emailFromName`, `updatedBy` or settings. */
const publicFields = {
	appName: z.string().nullable().describe("The product name shown in the app. Null uses the platform default."),
	primaryColor: z.string().nullable().describe("A #rrggbb colour."),
	secondaryColor: z.string().nullable().describe("A #rrggbb colour."),
	font: brandingFontSchema.nullable(),
	supportUrl: z.string().nullable(),
	termsUrl: z.string().nullable(),
	privacyUrl: z.string().nullable(),
};

export const brandingSchema = z.object({
	...publicFields,
	logoUrl: z.string().nullable().describe("Where the logo is served, or null when none was uploaded."),
	faviconUrl: z.string().nullable().describe("Where the favicon is served, or null when none was uploaded."),
	emailFromName: z.string().nullable().describe("The sender name on emails the organization sends."),
	emailReplyTo: z.string().nullable().describe("The Reply-To address on emails the organization sends."),
	updatedAt: z.date(),
});

export const publicBrandingSchema = z.object({
	organizationId: z.string(),
	slug: z.string(),
	...publicFields,
	logoUrl: z.string().nullable(),
	faviconUrl: z.string().nullable(),
});

/** Every field is optional: send only what changes. `null` resets a field to the platform default. */
export const brandingUpdateSchema = z.object({
	appName: text(60).nullable().optional(),
	primaryColor: colorSchema.nullable().optional(),
	secondaryColor: colorSchema.nullable().optional(),
	font: brandingFontSchema.nullable().optional(),
	emailFromName: text(80)
		.refine((value) => !CONTROL_OR_ANGLE.test(value), "Use a plain name without line breaks or angle brackets.")
		.nullable()
		.optional(),
	// CAREEROS (P2-T04): one bare address; the database CHECK has the same rule.
	emailReplyTo: z
		.string()
		.trim()
		.max(254)
		.refine(isSingleEmailAddress, "Use one address like help@example.com, without a name or angle brackets.")
		.nullable()
		.optional(),
	supportUrl: httpsUrlSchema.nullable().optional(),
	termsUrl: httpsUrlSchema.nullable().optional(),
	privacyUrl: httpsUrlSchema.nullable().optional(),
});

export type BrandingUpdate = z.infer<typeof brandingUpdateSchema>;

export const settingsSchema = z.object({
	openSignup: z.boolean().describe("Whether anyone can join the organization without an invitation."),
	updatedAt: z.date(),
});

export const settingsUpdateSchema = z.object({ openSignup: z.boolean().optional() });

export const LOGO_MAX_BYTES = 512 * 1024;
export const FAVICON_MAX_BYTES = 128 * 1024;

export const logoUploadSchema = z.object({
	file: z.file().max(LOGO_MAX_BYTES, "The logo must be 512 KB or smaller."),
});
export const faviconUploadSchema = z.object({
	file: z.file().max(FAVICON_MAX_BYTES, "The favicon must be 128 KB or smaller."),
});

export const uploadResultSchema = z.object({ url: z.string(), contentType: z.string() });

export const publicBySlugInput = z.object({ slug: z.string().trim().min(1).max(100) });
