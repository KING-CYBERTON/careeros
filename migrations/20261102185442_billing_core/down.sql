-- CAREEROS P3-T04 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops billing_event and the three functions and puts the subscription provider CHECK back to the T01 list. Refuses
-- while billing events exist or a subscription uses the `fake` provider, unless the session sets
-- careeros.allow_data_loss = 'yes' (the events are the idempotency record: dropping them would let a provider replay
-- be applied twice).
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes' AND (
		EXISTS (SELECT 1 FROM public.billing_event)
		OR EXISTS (SELECT 1 FROM public.subscription WHERE provider = 'fake')
	) THEN
		RAISE EXCEPTION 'P3-T04 down refused: billing events exist or a subscription uses the fake provider. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP FUNCTION IF EXISTS public.careeros_record_manual_payment(text, text, integer, text, timestamptz, timestamptz, bigint, text, text, text);
DROP FUNCTION IF EXISTS public.careeros_billing_due_orgs(timestamptz);
DROP FUNCTION IF EXISTS public.careeros_record_billing_event(text, text, text, text, text, text);
DROP TABLE IF EXISTS "billing_event";
UPDATE public.subscription SET provider = 'none' WHERE provider = 'fake';
ALTER TABLE "subscription" DROP CONSTRAINT IF EXISTS "subscription_provider_check";
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_provider_check" CHECK ("provider" in ('none', 'manual', 'paystack', 'stripe', 'mpesa'));
