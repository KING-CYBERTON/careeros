-- CAREEROS P4-T01 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the job discovery tables, so users lose their automations, run history and review queues (dismissed jobs
-- would come back if the tables are recreated). Refuses when any table holds rows, unless the session sets
-- careeros.allow_data_loss = 'yes'.
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes' AND (
		EXISTS (SELECT 1 FROM public.job_source) OR EXISTS (SELECT 1 FROM public.discovery_run) OR EXISTS (SELECT 1 FROM public.discovered_job)
	) THEN
		RAISE EXCEPTION 'P4-T01 down refused: job discovery tables hold rows. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP POLICY IF EXISTS "owner_access" ON "discovered_job";
DROP POLICY IF EXISTS "tenant_isolation" ON "discovered_job";
DROP POLICY IF EXISTS "owner_access" ON "discovery_run";
DROP POLICY IF EXISTS "tenant_isolation" ON "discovery_run";
DROP POLICY IF EXISTS "owner_access" ON "job_source";
DROP POLICY IF EXISTS "tenant_isolation" ON "job_source";
DROP TABLE IF EXISTS "discovered_job";
DROP TABLE IF EXISTS "discovery_run";
DROP TABLE IF EXISTS "job_source";
