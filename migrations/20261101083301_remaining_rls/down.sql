-- CAREEROS P1-T09 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- Refuses (and changes nothing) when going back would lose data: the old keys are per user, so a user with a domain or
-- web connection in two organizations, or the same erasure target queued in two, cannot be represented.
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM public.custom_domain GROUP BY user_id HAVING count(*) > 1) THEN
		RAISE EXCEPTION 'P1-T09 down refused: a user has custom domains in more than one organization';
	END IF;
	IF EXISTS (SELECT 1 FROM public.web_access_credentials GROUP BY user_id HAVING count(*) > 1) THEN
		RAISE EXCEPTION 'P1-T09 down refused: a user has web connections in more than one organization';
	END IF;
	IF EXISTS (SELECT 1 FROM public.storage_cleanup_job GROUP BY owner_id, storage_key HAVING count(*) > 1) THEN
		RAISE EXCEPTION 'P1-T09 down refused: an erasure target is queued in more than one organization';
	END IF;
END $$;
DROP FUNCTION IF EXISTS public.careeros_public_domain_owner(text);
DROP FUNCTION IF EXISTS public.careeros_verified_domains();
DROP FUNCTION IF EXISTS public.careeros_public_verified_domain(text);
DROP FUNCTION IF EXISTS public.careeros_release_domain_claims(text, text, text);
DROP FUNCTION IF EXISTS public.careeros_stale_custom_domains(timestamptz, integer);
DROP FUNCTION IF EXISTS public.careeros_due_storage_cleanup(timestamptz, integer, text, text[], text);
DROP FUNCTION IF EXISTS public.careeros_guest_cleanup_prefixes(text);
-- The trigger function goes back to the pre-T09 body (invoker rights, no organization).
CREATE OR REPLACE FUNCTION public.enqueue_account_storage_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER RESET search_path AS $$
BEGIN
	DELETE FROM storage_cleanup_job WHERE owner_id = OLD.id;
	INSERT INTO storage_cleanup_job (id, owner_id, storage_key)
	VALUES (OLD.id || ':account', OLD.id, 'uploads/' || OLD.id)
	ON CONFLICT (owner_id, storage_key) DO NOTHING;
	RETURN OLD;
END;
$$;
DROP POLICY IF EXISTS "owner_access" ON "custom_domain";
DROP POLICY IF EXISTS "tenant_isolation" ON "custom_domain";
ALTER TABLE "custom_domain" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "custom_domain" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "web_access_credentials";
DROP POLICY IF EXISTS "tenant_isolation" ON "web_access_credentials";
ALTER TABLE "web_access_credentials" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "web_access_credentials" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "storage_cleanup_job";
DROP POLICY IF EXISTS "tenant_isolation" ON "storage_cleanup_job";
ALTER TABLE "storage_cleanup_job" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "storage_cleanup_job" DISABLE ROW LEVEL SECURITY;
DROP INDEX IF EXISTS "storage_cleanup_job_org_due_index";
ALTER TABLE "storage_cleanup_job" DROP CONSTRAINT IF EXISTS "storage_cleanup_job_owner_key_unique";
ALTER TABLE "storage_cleanup_job" ADD CONSTRAINT "storage_cleanup_job_owner_key_unique" UNIQUE ("owner_id", "storage_key");
ALTER TABLE "storage_cleanup_job" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "custom_domain" DROP CONSTRAINT IF EXISTS "custom_domain_pkey";
ALTER TABLE "custom_domain" ADD PRIMARY KEY ("user_id");
ALTER TABLE "custom_domain" DROP CONSTRAINT IF EXISTS "custom_domain_organization_id_organization_id_fkey";
ALTER TABLE "custom_domain" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "web_access_credentials" DROP CONSTRAINT IF EXISTS "web_access_credentials_pkey";
ALTER TABLE "web_access_credentials" ADD PRIMARY KEY ("user_id");
ALTER TABLE "web_access_credentials" DROP CONSTRAINT IF EXISTS "web_access_credentials_organization_id_organization_id_fkey";
ALTER TABLE "web_access_credentials" DROP COLUMN IF EXISTS "organization_id";
