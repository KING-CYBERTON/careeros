-- CAREEROS P6-T02 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the two definer functions and email_suppression. Refuses while addresses are suppressed, unless the session
-- sets careeros.allow_data_loss = 'yes' (dropping the list means mailing addresses that bounced or complained again,
-- which hurts the sending domain's reputation).
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes'
		AND to_regclass('public.email_suppression') IS NOT NULL
		AND EXISTS (SELECT 1 FROM public.email_suppression)
	THEN
		RAISE EXCEPTION 'P6-T02 down refused: email_suppression holds rows. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP FUNCTION IF EXISTS public.careeros_email_suppress(text, text, text);
DROP FUNCTION IF EXISTS public.careeros_email_is_suppressed(text);
DROP TABLE IF EXISTS "email_suppression";
