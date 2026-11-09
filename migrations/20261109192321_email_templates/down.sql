-- CAREEROS P5-T04 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the email_template table with its policies, index and keys. Every email template, the organizations'
-- defaults and the members' own, is lost. Refuses when any template exists, unless the session sets
-- careeros.allow_data_loss = 'yes'.
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes'
		AND EXISTS (SELECT 1 FROM public.email_template) THEN
		RAISE EXCEPTION 'P5-T04 down refused: email templates exist. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP POLICY IF EXISTS "owner_access" ON "email_template";
DROP POLICY IF EXISTS "tenant_isolation" ON "email_template";
DROP TABLE IF EXISTS "email_template";
