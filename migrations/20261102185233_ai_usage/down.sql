-- CAREEROS P3-T03 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops ai_usage and so loses every metered AI call. Refuses when the table holds rows, unless the session sets
-- careeros.allow_data_loss = 'yes'.
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes'
		AND to_regclass('public.ai_usage') IS NOT NULL
		AND EXISTS (SELECT 1 FROM public.ai_usage) THEN
		RAISE EXCEPTION 'P3-T03 down refused: ai_usage holds rows. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP TABLE IF EXISTS "ai_usage";
