-- CAREEROS P2-T06 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the organization domain table, its queue and its functions, so organizations lose their custom domains
-- (the hostnames registered at Cloudflare stay there and must be deleted by hand). Refuses when either table holds
-- rows, unless the session sets careeros.allow_data_loss = 'yes'.
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes' AND (
		EXISTS (SELECT 1 FROM public.organization_domain) OR EXISTS (SELECT 1 FROM public.organization_domain_cf_cleanup)
	) THEN
		RAISE EXCEPTION 'P2-T06 down refused: organizations have custom domains. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP TRIGGER IF EXISTS "careeros_custom_domain_guard" ON "custom_domain";
DROP TRIGGER IF EXISTS "careeros_org_domain_cf_cleanup" ON "organization_domain";
DROP FUNCTION IF EXISTS public.careeros_custom_domain_guard();
DROP FUNCTION IF EXISTS public.careeros_org_domain_cf_cleanup_enqueue();
DROP FUNCTION IF EXISTS public.careeros_claim_org_domain(text, text, text, text, text, text[], text, text);
DROP FUNCTION IF EXISTS public.careeros_org_for_custom_host(text);
DROP FUNCTION IF EXISTS public.careeros_org_domain_is_registered(text);
DROP FUNCTION IF EXISTS public.careeros_org_open_signup(text);
DROP FUNCTION IF EXISTS public.careeros_org_domains_due(integer);
DROP POLICY IF EXISTS "owner_access" ON "organization_domain";
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_domain";
DROP TABLE IF EXISTS "organization_domain_cf_cleanup";
DROP TABLE IF EXISTS "organization_domain";
