-- CAREEROS P1-T04 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- Drops the functions, policies and columns, then the organizations the backfill created. A backfilled organization
-- is marked metadata = '{"careeros_backfill":true}'. A session whose active organization was a backfilled one is
-- cleared first.
DROP FUNCTION IF EXISTS public.careeros_public_resume_org(text, text);
DROP FUNCTION IF EXISTS public.careeros_public_resume_org_by_redirect(text, text);
DROP FUNCTION IF EXISTS public.careeros_public_primary_resume_org(text);
DROP FUNCTION IF EXISTS public.careeros_public_resume_org_by_id(text);
DROP FUNCTION IF EXISTS public.careeros_public_indexable_resumes(integer, integer, boolean);
DROP FUNCTION IF EXISTS public.careeros_public_indexable_resume_count(boolean);
DROP FUNCTION IF EXISTS public.careeros_resume_count();
DROP FUNCTION IF EXISTS public.careeros_move_guest_resumes(text, text, text);
DROP POLICY IF EXISTS "owner_access" ON "resume";
DROP POLICY IF EXISTS "tenant_isolation" ON "resume";
ALTER TABLE "resume" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "resume" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "resume_version";
DROP POLICY IF EXISTS "tenant_isolation" ON "resume_version";
ALTER TABLE "resume_version" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "resume_version" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "resume_slug_redirect";
DROP POLICY IF EXISTS "tenant_isolation" ON "resume_slug_redirect";
ALTER TABLE "resume_slug_redirect" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "resume_slug_redirect" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "resume_statistics";
DROP POLICY IF EXISTS "tenant_isolation" ON "resume_statistics";
ALTER TABLE "resume_statistics" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "resume_statistics" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "resume_statistics_daily";
DROP POLICY IF EXISTS "tenant_isolation" ON "resume_statistics_daily";
ALTER TABLE "resume_statistics_daily" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "resume_statistics_daily" DISABLE ROW LEVEL SECURITY;
DROP INDEX IF EXISTS "resume_organization_id_user_id_updated_at_index";
DROP INDEX IF EXISTS "resume_version_organization_id_resume_id_created_at_index";
DROP INDEX IF EXISTS "resume_slug_redirect_organization_id_resume_id_index";
DROP INDEX IF EXISTS "resume_statistics_organization_id_resume_id_index";
DROP INDEX IF EXISTS "resume_statistics_daily_organization_id_resume_id_date_index";
ALTER TABLE "resume" DROP CONSTRAINT IF EXISTS "resume_organization_id_organization_id_fkey";
ALTER TABLE "resume" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "resume_version" DROP CONSTRAINT IF EXISTS "resume_version_organization_id_organization_id_fkey";
ALTER TABLE "resume_version" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "resume_slug_redirect" DROP CONSTRAINT IF EXISTS "resume_slug_redirect_organization_id_organization_id_fkey";
ALTER TABLE "resume_slug_redirect" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "resume_statistics" DROP CONSTRAINT IF EXISTS "resume_statistics_organization_id_organization_id_fkey";
ALTER TABLE "resume_statistics" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "resume_statistics_daily" DROP CONSTRAINT IF EXISTS "resume_statistics_daily_organization_id_organization_id_fkey";
ALTER TABLE "resume_statistics_daily" DROP COLUMN IF EXISTS "organization_id";
UPDATE "session" SET "active_organization_id" = NULL
	WHERE "active_organization_id" IN (SELECT "id" FROM "organization" WHERE "metadata" = '{"careeros_backfill":true}');
DELETE FROM "organization" WHERE "metadata" = '{"careeros_backfill":true}';
