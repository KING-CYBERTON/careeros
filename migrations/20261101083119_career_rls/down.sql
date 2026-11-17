-- CAREEROS P1-T07 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- Restores the per-user keys: career_profile keyed by user_id, the unique keys and indexes on user_id, and
-- career_workspace's single foreign key on application_id. It REFUSES to run while a user has career rows in more than
-- one organization, because those keys allow one row per user: delete or merge the extra organization's rows first.
-- Organizations the up migration may have backfilled (same marker as P1-T04) are left for P1-T04's down migration.
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM (
	SELECT user_id, organization_id FROM "career_profile"
	UNION
	SELECT user_id, organization_id FROM "career_fact"
	UNION
	SELECT user_id, organization_id FROM "career_story"
	UNION
	SELECT user_id, organization_id FROM "career_artifact"
	UNION
	SELECT user_id, organization_id FROM "career_schedule"
	UNION
	SELECT user_id, organization_id FROM "career_job"
	UNION
	SELECT user_id, organization_id FROM "career_notification"
	UNION
	SELECT user_id, organization_id FROM "career_opportunity"
	UNION
	SELECT user_id, organization_id FROM "career_workspace"
	UNION
	SELECT user_id, organization_id FROM "career_transcript"
	UNION
	SELECT user_id, organization_id FROM "career_answer"
		) r GROUP BY user_id HAVING count(DISTINCT organization_id) > 1
	) THEN
		RAISE EXCEPTION 'P1-T07 down migration refused: a user has career rows in more than one organization';
	END IF;
END $$;
DROP FUNCTION IF EXISTS public.careeros_orgs_with_career_upkeep(timestamptz);
DROP FUNCTION IF EXISTS public.careeros_orgs_with_due_career_schedules(timestamptz);
DROP FUNCTION IF EXISTS public.careeros_due_career_jobs(timestamptz, integer);
DROP FUNCTION IF EXISTS public.careeros_move_guest_career(text, text, text);
-- The interim scheduler functions of P1-T06.
CREATE OR REPLACE FUNCTION public.careeros_application_is_open(application_id text, owner_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT EXISTS (SELECT 1 FROM public.application a WHERE a.id = $1 AND a.user_id = $2 AND a.status <> 'closed')
$$;
CREATE OR REPLACE FUNCTION public.careeros_application_org(application_id text, owner_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT a.organization_id FROM public.application a WHERE a.id = $1 AND a.user_id = $2
$$;
REVOKE ALL ON FUNCTION public.careeros_application_is_open(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.careeros_application_org(text, text) FROM PUBLIC;
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_application_is_open(text, text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_application_org(text, text) TO careeros_app;
	END IF;
END $$;
DROP POLICY IF EXISTS "owner_access" ON "career_profile";
DROP POLICY IF EXISTS "tenant_isolation" ON "career_profile";
ALTER TABLE "career_profile" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "career_profile" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "career_fact";
DROP POLICY IF EXISTS "tenant_isolation" ON "career_fact";
ALTER TABLE "career_fact" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "career_fact" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "career_story";
DROP POLICY IF EXISTS "tenant_isolation" ON "career_story";
ALTER TABLE "career_story" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "career_story" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "career_artifact";
DROP POLICY IF EXISTS "tenant_isolation" ON "career_artifact";
ALTER TABLE "career_artifact" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "career_artifact" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "career_schedule";
DROP POLICY IF EXISTS "tenant_isolation" ON "career_schedule";
ALTER TABLE "career_schedule" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "career_schedule" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "career_job";
DROP POLICY IF EXISTS "tenant_isolation" ON "career_job";
ALTER TABLE "career_job" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "career_job" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "career_notification";
DROP POLICY IF EXISTS "tenant_isolation" ON "career_notification";
ALTER TABLE "career_notification" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "career_notification" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "career_opportunity";
DROP POLICY IF EXISTS "tenant_isolation" ON "career_opportunity";
ALTER TABLE "career_opportunity" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "career_opportunity" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "career_workspace";
DROP POLICY IF EXISTS "tenant_isolation" ON "career_workspace";
ALTER TABLE "career_workspace" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "career_workspace" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "career_transcript";
DROP POLICY IF EXISTS "tenant_isolation" ON "career_transcript";
ALTER TABLE "career_transcript" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "career_transcript" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_access" ON "career_answer";
DROP POLICY IF EXISTS "tenant_isolation" ON "career_answer";
ALTER TABLE "career_answer" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "career_answer" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "career_workspace" DROP CONSTRAINT IF EXISTS "career_workspace_org_application_fkey";
ALTER TABLE "career_workspace" ADD CONSTRAINT "career_workspace_application_id_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE;
ALTER TABLE "application" DROP CONSTRAINT IF EXISTS "application_organization_id_id_unique";
ALTER TABLE "career_profile" DROP CONSTRAINT "career_profile_pkey";
ALTER TABLE "career_profile" ADD PRIMARY KEY ("user_id");
DROP INDEX IF EXISTS "career_answer_organization_id_user_id_duplicate_key_index";
CREATE UNIQUE INDEX IF NOT EXISTS "career_answer_user_id_duplicate_key_index" ON "career_answer" ("user_id","duplicate_key");
DROP INDEX IF EXISTS "career_artifact_organization_id_user_id_application_id_created_at_index";
CREATE INDEX IF NOT EXISTS "career_artifact_user_id_application_id_created_at_index" ON "career_artifact" ("user_id","application_id","created_at");
DROP INDEX IF EXISTS "career_fact_organization_id_user_id_application_id_status_index";
CREATE INDEX IF NOT EXISTS "career_fact_user_id_application_id_status_index" ON "career_fact" ("user_id","application_id","status");
DROP INDEX IF EXISTS "career_fact_organization_id_user_id_source_key_index";
CREATE UNIQUE INDEX IF NOT EXISTS "career_fact_user_id_source_key_index" ON "career_fact" ("user_id","source_key");
DROP INDEX IF EXISTS "career_notification_organization_id_user_id_key_index";
CREATE UNIQUE INDEX IF NOT EXISTS "career_notification_user_id_key_index" ON "career_notification" ("user_id","key");
DROP INDEX IF EXISTS "career_notification_organization_id_user_id_created_at_index";
CREATE INDEX IF NOT EXISTS "career_notification_user_id_created_at_index" ON "career_notification" ("user_id","created_at");
DROP INDEX IF EXISTS "career_opportunity_organization_id_user_id_url_index";
CREATE UNIQUE INDEX IF NOT EXISTS "career_opportunity_user_id_url_index" ON "career_opportunity" ("user_id","url");
DROP INDEX IF EXISTS "career_story_organization_id_user_id_application_id_index";
CREATE INDEX IF NOT EXISTS "career_story_user_id_application_id_index" ON "career_story" ("user_id","application_id");
DROP INDEX IF EXISTS "career_transcript_organization_id_user_id_application_id_index";
CREATE INDEX IF NOT EXISTS "career_transcript_user_id_application_id_index" ON "career_transcript" ("user_id","application_id");
ALTER TABLE "career_profile" DROP CONSTRAINT IF EXISTS "career_profile_organization_id_organization_id_fkey";
ALTER TABLE "career_profile" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "career_fact" DROP CONSTRAINT IF EXISTS "career_fact_organization_id_organization_id_fkey";
ALTER TABLE "career_fact" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "career_story" DROP CONSTRAINT IF EXISTS "career_story_organization_id_organization_id_fkey";
ALTER TABLE "career_story" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "career_artifact" DROP CONSTRAINT IF EXISTS "career_artifact_organization_id_organization_id_fkey";
ALTER TABLE "career_artifact" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "career_schedule" DROP CONSTRAINT IF EXISTS "career_schedule_organization_id_organization_id_fkey";
ALTER TABLE "career_schedule" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "career_job" DROP CONSTRAINT IF EXISTS "career_job_organization_id_organization_id_fkey";
ALTER TABLE "career_job" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "career_notification" DROP CONSTRAINT IF EXISTS "career_notification_organization_id_organization_id_fkey";
ALTER TABLE "career_notification" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "career_opportunity" DROP CONSTRAINT IF EXISTS "career_opportunity_organization_id_organization_id_fkey";
ALTER TABLE "career_opportunity" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "career_workspace" DROP CONSTRAINT IF EXISTS "career_workspace_organization_id_organization_id_fkey";
ALTER TABLE "career_workspace" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "career_transcript" DROP CONSTRAINT IF EXISTS "career_transcript_organization_id_organization_id_fkey";
ALTER TABLE "career_transcript" DROP COLUMN IF EXISTS "organization_id";
ALTER TABLE "career_answer" DROP CONSTRAINT IF EXISTS "career_answer_organization_id_organization_id_fkey";
ALTER TABLE "career_answer" DROP COLUMN IF EXISTS "organization_id";
