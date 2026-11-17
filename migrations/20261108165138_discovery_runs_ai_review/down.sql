-- CAREEROS P4-T02 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the scheduler and guest-move functions and the columns P4-T02 added: the accepted jobs lose their link to
-- the tracker application, runs lose their AI counts and skip reason, and automations lose their scheduled-run time.
-- Refuses when any of that data exists, unless the session sets careeros.allow_data_loss = 'yes'. The three keys of
-- P4-T01 go back to NOT DEFERRABLE. The next_run_at backfill is not undone (the column is P4-T01's).
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes' AND (
		EXISTS (SELECT 1 FROM public.discovered_job WHERE application_id IS NOT NULL OR accepted_at IS NOT NULL)
		OR EXISTS (SELECT 1 FROM public.discovery_run WHERE trigger <> 'manual' OR ai_planned > 0 OR ai_skipped_reason IS NOT NULL)
		OR EXISTS (SELECT 1 FROM public.job_source WHERE last_scheduled_run_at IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'P4-T02 down refused: discovery rows hold data in the columns it added. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP FUNCTION IF EXISTS public.careeros_move_guest_discovery(text, text, text);
DROP FUNCTION IF EXISTS public.careeros_orgs_with_stale_discovery_runs(timestamptz, integer);
DROP FUNCTION IF EXISTS public.careeros_due_discovery_sources(timestamptz, integer);
ALTER TABLE "discovered_job" ALTER CONSTRAINT "discovered_job_org_job_source_fkey" NOT DEFERRABLE;
ALTER TABLE "discovered_job" ALTER CONSTRAINT "discovered_job_org_first_run_fkey" NOT DEFERRABLE;
ALTER TABLE "discovery_run" ALTER CONSTRAINT "discovery_run_org_job_source_fkey" NOT DEFERRABLE;
ALTER TABLE "discovery_run" DROP CONSTRAINT IF EXISTS "discovery_run_ai_planned_check";
ALTER TABLE "discovery_run" DROP CONSTRAINT IF EXISTS "discovery_run_ai_skipped_reason_check";
ALTER TABLE "discovery_run" DROP CONSTRAINT IF EXISTS "discovery_run_trigger_check";
ALTER TABLE "discovered_job" DROP CONSTRAINT IF EXISTS "discovered_job_org_application_fkey";
DROP INDEX IF EXISTS "discovered_job_application_idx";
ALTER TABLE "discovered_job" DROP COLUMN IF EXISTS "accepted_at";
ALTER TABLE "discovered_job" DROP COLUMN IF EXISTS "application_id";
ALTER TABLE "discovery_run" DROP COLUMN IF EXISTS "ai_skipped_reason";
ALTER TABLE "discovery_run" DROP COLUMN IF EXISTS "ai_planned";
ALTER TABLE "discovery_run" DROP COLUMN IF EXISTS "trigger";
ALTER TABLE "job_source" DROP COLUMN IF EXISTS "last_scheduled_run_at";
