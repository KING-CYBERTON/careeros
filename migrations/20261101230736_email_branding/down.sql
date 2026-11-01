-- CAREEROS P2-T04 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the email lookup function and the email_reply_to column, so it loses every organization's reply-to address.
-- Refuses when any organization has one, unless the session sets careeros.allow_data_loss = 'yes'.
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes'
		AND EXISTS (SELECT 1 FROM public.organization_branding b WHERE b.email_reply_to IS NOT NULL) THEN
		RAISE EXCEPTION 'P2-T04 down refused: organizations have a reply-to address. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP FUNCTION IF EXISTS public.careeros_email_branding(text);
ALTER TABLE "organization_branding" DROP CONSTRAINT IF EXISTS "organization_branding_email_reply_to_check";
ALTER TABLE "organization_branding" DROP COLUMN IF EXISTS "email_reply_to";
