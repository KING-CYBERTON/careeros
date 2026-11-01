-- CAREEROS P1-T05 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- Drops the function, policies, indexes and columns of the two cover letter tables. Organizations the up migration may
-- have backfilled (same marker as P1-T04) are left for P1-T04's down migration, which owns that marker.
DROP FUNCTION IF EXISTS public.careeros_move_guest_cover_letters(text, text, text);
DROP POLICY IF EXISTS "owner_access" ON "cover_letter";
DROP POLICY IF EXISTS "tenant_isolation" ON "cover_letter";
ALTER TABLE "cover_letter" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "cover_letter" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "cover_letter_version";
DROP POLICY IF EXISTS "tenant_isolation" ON "cover_letter_version";
ALTER TABLE "cover_letter_version" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "cover_letter_version" DISABLE ROW LEVEL SECURITY;
DROP INDEX IF EXISTS "cover_letter_organization_id_user_id_updated_at_id_index";
DROP INDEX IF EXISTS "cover_letter_version_organization_id_cover_letter_id_created_at_index";
ALTER TABLE "cover_letter" DROP CONSTRAINT IF EXISTS "cover_letter_organization_id_organization_id_fkey";
ALTER TABLE "cover_letter" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "cover_letter_version" DROP CONSTRAINT IF EXISTS "cover_letter_version_organization_id_organization_id_fkey";
ALTER TABLE "cover_letter_version" DROP COLUMN IF EXISTS "organization_id";
