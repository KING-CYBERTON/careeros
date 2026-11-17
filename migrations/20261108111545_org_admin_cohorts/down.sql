-- CAREEROS P3-T08 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the cohort table, the cohort column of invitation, the keys from member and invitation to cohort and the
-- four indexes this migration added (member.cohort_id stays, as before the migration, but loses its meaning). Cohorts
-- and the cohort of each member and pending invitation are lost. Refuses when any cohort exists or any member or
-- invitation names one, unless the session sets careeros.allow_data_loss = 'yes'.
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes' AND (
		EXISTS (SELECT 1 FROM public.cohort)
		OR EXISTS (SELECT 1 FROM public.member WHERE cohort_id IS NOT NULL)
		OR EXISTS (SELECT 1 FROM public.invitation WHERE cohort_id IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'P3-T08 down refused: cohorts exist or members name one. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
ALTER TABLE "member" DROP CONSTRAINT IF EXISTS "member_org_cohort_fkey";
ALTER TABLE "invitation" DROP CONSTRAINT IF EXISTS "invitation_org_cohort_fkey";
DROP INDEX IF EXISTS "member_org_cohort_idx";
DROP INDEX IF EXISTS "session_active_org_user_idx";
DROP INDEX IF EXISTS "resume_org_created_idx";
DROP INDEX IF EXISTS "application_org_created_idx";
ALTER TABLE "invitation" DROP COLUMN IF EXISTS "cohort_id";
DROP POLICY IF EXISTS "owner_access" ON "cohort";
DROP POLICY IF EXISTS "tenant_isolation" ON "cohort";
DROP TABLE IF EXISTS "cohort";
