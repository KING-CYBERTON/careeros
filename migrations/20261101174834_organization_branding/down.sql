-- CAREEROS P2-T01 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the two tables and their lookup functions, so it loses every organization's branding and settings (the
-- storage objects of uploaded logos stay in storage). Refuses when a table holds anything other than defaults, unless
-- the session sets careeros.allow_data_loss = 'yes'.
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes' AND (
		EXISTS (SELECT 1 FROM public.organization_branding b WHERE
			b.app_name IS NOT NULL OR b.logo_storage_key IS NOT NULL OR b.favicon_storage_key IS NOT NULL
			OR b.primary_color IS NOT NULL OR b.secondary_color IS NOT NULL OR b.font IS NOT NULL
			OR b.email_from_name IS NOT NULL OR b.support_url IS NOT NULL OR b.terms_url IS NOT NULL
			OR b.privacy_url IS NOT NULL)
		OR EXISTS (SELECT 1 FROM public.organization_settings s WHERE s.open_signup)
	) THEN
		RAISE EXCEPTION 'P2-T01 down refused: organizations have branding or settings. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP TRIGGER IF EXISTS "careeros_organization_defaults" ON "organization";
DROP FUNCTION IF EXISTS public.create_organization_defaults();
DROP FUNCTION IF EXISTS public.careeros_public_branding(text);
DROP FUNCTION IF EXISTS public.careeros_public_branding_by_slug(text);
DROP POLICY IF EXISTS "owner_access" ON "organization_branding";
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_branding";
DROP POLICY IF EXISTS "owner_access" ON "organization_settings";
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_settings";
DROP TABLE IF EXISTS "organization_branding";
DROP TABLE IF EXISTS "organization_settings";
