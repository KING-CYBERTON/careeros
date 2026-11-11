-- CAREEROS P3-T10 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the organization_billing_profile table with its policies and keys. Every organization's saved billing
-- details (legal name, address, tax PIN, billing email) are lost. Refuses when any row exists, unless the session sets
-- careeros.allow_data_loss = 'yes'.
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes'
		AND EXISTS (SELECT 1 FROM public.organization_billing_profile) THEN
		RAISE EXCEPTION 'P3-T10 down refused: billing profiles exist. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP POLICY IF EXISTS "owner_access" ON "organization_billing_profile";
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_billing_profile";
DROP TABLE IF EXISTS "organization_billing_profile";
