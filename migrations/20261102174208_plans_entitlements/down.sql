-- CAREEROS P3-T01 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the four tables, the functions, the triggers and the three organization columns, so it loses every plan
-- assignment, subscription, feature flag and audit row. Refuses when any organization has left the defaults (a plan
-- other than 'personal', a status other than 'active', a subscription with a provider or non-default state) or a flag
-- or audit row exists, unless the session sets careeros.allow_data_loss = 'yes'.
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes' AND (
		EXISTS (SELECT 1 FROM public.organization o WHERE o.plan_id <> 'personal' OR o.status <> 'active' OR o.status_changed_at IS NOT NULL)
		OR EXISTS (SELECT 1 FROM public.subscription s WHERE s.provider <> 'none' OR s.status <> 'none' OR s.seats <> 1
			OR s.provider_customer_id IS NOT NULL OR s.provider_subscription_id IS NOT NULL OR s.billing_interval IS NOT NULL
			OR s.current_period_start IS NOT NULL OR s.current_period_end IS NOT NULL OR s.trial_ends_at IS NOT NULL
			OR s.grace_ends_at IS NOT NULL OR s.ai_overage_allowed)
		OR EXISTS (SELECT 1 FROM public.feature_flag)
		OR EXISTS (SELECT 1 FROM public.audit_log)
	) THEN
		RAISE EXCEPTION 'P3-T01 down refused: plans, subscriptions, flags or audit rows hold data. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP TRIGGER IF EXISTS "careeros_organization_plan_guard" ON "organization";
DROP TRIGGER IF EXISTS "careeros_organization_subscription" ON "organization";
DROP FUNCTION IF EXISTS public.careeros_organization_plan_guard();
DROP FUNCTION IF EXISTS public.create_organization_subscription();
DROP FUNCTION IF EXISTS public.careeros_set_org_plan(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.careeros_set_subscription(text, jsonb, text, text);
DROP FUNCTION IF EXISTS public.careeros_audit_platform(text, text, text, text, text, jsonb, text);
DROP TABLE IF EXISTS "audit_log";
DROP TABLE IF EXISTS "feature_flag";
DROP TABLE IF EXISTS "subscription";
ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "organization_status_check";
ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "organization_plan_id_plan_id_fkey";
ALTER TABLE "organization" DROP COLUMN IF EXISTS "status_changed_at";
ALTER TABLE "organization" DROP COLUMN IF EXISTS "plan_id";
ALTER TABLE "organization" DROP COLUMN IF EXISTS "status";
DROP TABLE IF EXISTS "plan";
DROP FUNCTION IF EXISTS public.careeros_uuidv7();
