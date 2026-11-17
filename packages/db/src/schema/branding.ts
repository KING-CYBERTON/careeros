import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

/**
 * CAREEROS (P2-T01, phase plan D1, D6, D11): the fonts an organization can pick for its branding. All of them are in
 * `@reactive-resume/fonts`; Figtree is the UI font. The migration's CHECK constraint mirrors this list, so changing it
 * needs a new migration.
 */
export const BRANDING_FONTS = [
	"Figtree",
	"Inter",
	"IBM Plex Sans",
	"Roboto",
	"Open Sans",
	"Lato",
	"Merriweather",
	"Lora",
] as const;

export type BrandingFont = (typeof BRANDING_FONTS)[number];

const HEX_COLOR = "^#[0-9a-fA-F]{6}$";
// CAREEROS (P2-T04): exactly one "@", and no whitespace, control character, angle bracket, comma or semicolon.
const EMAIL_ADDRESS = "^[^@[:space:][:cntrl:]<>,;]+@[^@[:space:][:cntrl:]<>,;]+$";
const fontList = sql.raw(BRANDING_FONTS.map((font) => `'${font}'`).join(", "));

/** One row per organization. Every column is nullable: null means "use the platform default". */
export const organizationBranding = pg.pgTable(
	"organization_branding",
	{
		organizationId: pg
			.text("organization_id")
			.notNull()
			.primaryKey()
			.references(() => organization.id, { onDelete: "cascade" }),
		appName: pg.text("app_name"),
		logoStorageKey: pg.text("logo_storage_key"),
		faviconStorageKey: pg.text("favicon_storage_key"),
		primaryColor: pg.text("primary_color"),
		secondaryColor: pg.text("secondary_color"),
		font: pg.text("font"),
		emailFromName: pg.text("email_from_name"),
		// CAREEROS (P2-T04): one address, no display name; the CHECK below mirrors `isSingleEmailAddress` in utils/brand.
		emailReplyTo: pg.text("email_reply_to"),
		supportUrl: pg.text("support_url"),
		termsUrl: pg.text("terms_url"),
		privacyUrl: pg.text("privacy_url"),
		updatedAt: pg.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
		updatedBy: pg.text("updated_by").references(() => user.id, { onDelete: "set null" }),
	},
	(t) => [
		pg.check("organization_branding_primary_color_check", sql`${t.primaryColor} ~ ${sql.raw(`'${HEX_COLOR}'`)}`),
		pg.check("organization_branding_secondary_color_check", sql`${t.secondaryColor} ~ ${sql.raw(`'${HEX_COLOR}'`)}`),
		pg.check("organization_branding_font_check", sql`${t.font} in (${fontList})`),
		pg.check("organization_branding_email_reply_to_check", sql`${t.emailReplyTo} ~ ${sql.raw(`'${EMAIL_ADDRESS}'`)}`),
		pg.check("organization_branding_support_url_check", sql`${t.supportUrl} like 'https://%'`),
		pg.check("organization_branding_terms_url_check", sql`${t.termsUrl} like 'https://%'`),
		pg.check("organization_branding_privacy_url_check", sql`${t.privacyUrl} like 'https://%'`),
	],
);

/** One row per organization: switches that are not branding. */
export const organizationSettings = pg.pgTable("organization_settings", {
	organizationId: pg
		.text("organization_id")
		.notNull()
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	openSignup: pg.boolean("open_signup").notNull().default(false),
	updatedAt: pg.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
