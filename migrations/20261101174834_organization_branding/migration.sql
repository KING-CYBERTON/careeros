CREATE TABLE "organization_branding" (
	"organization_id" text PRIMARY KEY,
	"app_name" text,
	"logo_storage_key" text,
	"favicon_storage_key" text,
	"primary_color" text,
	"secondary_color" text,
	"font" text,
	"email_from_name" text,
	"support_url" text,
	"terms_url" text,
	"privacy_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "organization_branding_primary_color_check" CHECK ("primary_color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "organization_branding_secondary_color_check" CHECK ("secondary_color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "organization_branding_font_check" CHECK ("font" in ('Figtree', 'Inter', 'IBM Plex Sans', 'Roboto', 'Open Sans', 'Lato', 'Merriweather', 'Lora')),
	CONSTRAINT "organization_branding_support_url_check" CHECK ("support_url" like 'https://%'),
	CONSTRAINT "organization_branding_terms_url_check" CHECK ("terms_url" like 'https://%'),
	CONSTRAINT "organization_branding_privacy_url_check" CHECK ("privacy_url" like 'https://%')
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" text PRIMARY KEY,
	"open_signup" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_updated_by_user_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
-- CAREEROS P2-T01: organization branding and settings (phase plan D1, D6, D11). Everything below the generated DDL is
-- written by hand, following P1-T09, and is idempotent (the generated DDL above is not). Runs as the migration (owner) role. Down migration: down.sql
-- in this folder.
--> statement-breakpoint
-- 1. Row-level security (D4), exactly as P1-T04: FORCE applies the policy to the table owner too, so only owner_access
-- lets the owner role (migrations, definer functions) see every organization. careeros_app only matches its own
-- organization; an unset setting is NULL and matches nothing (fail closed).
ALTER TABLE "organization_branding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_branding" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_branding";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organization_branding"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "organization_branding";--> statement-breakpoint
CREATE POLICY "owner_access" ON "organization_branding" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "organization_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_settings";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organization_settings"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "organization_settings";--> statement-breakpoint
CREATE POLICY "owner_access" ON "organization_settings" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
-- 2. Backfill: one default row (all branding null, open_signup false) for every existing organization.
INSERT INTO "organization_branding" ("organization_id") SELECT o."id" FROM "organization" o ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "organization_settings" ("organization_id") SELECT o."id" FROM "organization" o ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 3. New organizations get both rows in the same statement that creates them. An AFTER INSERT trigger, not the
-- organization plugin's afterCreateOrganization hook: organizations are also inserted outside the plugin (the signup
-- hook, backfills, tests), and the hook runs after the insert has committed, so a crash between the two would leave an
-- organization without rows. The function runs as the owner so it works whatever role or organization context
-- inserted the organization.
CREATE OR REPLACE FUNCTION public.create_organization_defaults() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	INSERT INTO public.organization_branding (organization_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
	INSERT INTO public.organization_settings (organization_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
	RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "careeros_organization_defaults" ON "organization";--> statement-breakpoint
CREATE TRIGGER "careeros_organization_defaults" AFTER INSERT ON "organization"
	FOR EACH ROW EXECUTE FUNCTION public.create_organization_defaults();--> statement-breakpoint
-- 4. Public branding lookups run without an organization (login page, custom domains). They return only the public
-- fields: never email_from_name, updated_by or the settings. An unknown organization returns no row. (There is no
-- organization status column yet, so there is nothing to filter on for suspended ones.) Pinned search_path; execute is
-- revoked from PUBLIC and granted to careeros_app below.
CREATE OR REPLACE FUNCTION public.careeros_public_branding(org_id text) RETURNS TABLE (
	organization_id text, slug text, app_name text, logo_storage_key text, favicon_storage_key text,
	primary_color text, secondary_color text, font text, support_url text, terms_url text, privacy_url text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT o.id, o.slug, b.app_name, b.logo_storage_key, b.favicon_storage_key, b.primary_color, b.secondary_color,
		b.font, b.support_url, b.terms_url, b.privacy_url
	FROM public.organization o LEFT JOIN public.organization_branding b ON b.organization_id = o.id
	WHERE o.id = $1
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.careeros_public_branding_by_slug(org_slug text) RETURNS TABLE (
	organization_id text, slug text, app_name text, logo_storage_key text, favicon_storage_key text,
	primary_color text, secondary_color text, font text, support_url text, terms_url text, privacy_url text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT o.id, o.slug, b.app_name, b.logo_storage_key, b.favicon_storage_key, b.primary_color, b.secondary_color,
		b.font, b.support_url, b.terms_url, b.privacy_url
	FROM public.organization o LEFT JOIN public.organization_branding b ON b.organization_id = o.id
	WHERE o.slug = $1
$$;--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_public_branding(text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_public_branding_by_slug(text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.create_organization_defaults() FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_public_branding(text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_public_branding_by_slug(text) TO careeros_app;
	END IF;
END $$;
