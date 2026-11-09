-- CAREEROS P3-T05 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops billing_provider_plan, the five definer functions, and the two pending seat columns, and puts
-- careeros_set_subscription back to the T01 allow-list. Refuses while provider plans are cached or a seat change is
-- pending, unless the session sets careeros.allow_data_loss = 'yes' (a cached plan code is the only link to a plan that
-- exists at the provider; a pending change is a promise to the customer).
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes' AND (
		EXISTS (SELECT 1 FROM public.billing_provider_plan)
		OR EXISTS (SELECT 1 FROM public.subscription WHERE pending_seats IS NOT NULL OR pending_replaces_subscription_id IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'P3-T05 down refused: provider plans are cached or a seat change is pending. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP FUNCTION IF EXISTS public.careeros_billing_reminder_orgs(text, timestamptz);
DROP FUNCTION IF EXISTS public.careeros_billing_org_by_provider_ref(text, text, text);
DROP FUNCTION IF EXISTS public.careeros_billing_provider_plan_by_code(text, text);
DROP FUNCTION IF EXISTS public.careeros_billing_provider_plan_put(text, text, text, text, integer, bigint, text);
DROP FUNCTION IF EXISTS public.careeros_billing_provider_plan_get(text, text, text, text, integer, bigint);
CREATE OR REPLACE FUNCTION public.careeros_set_subscription(
	p_org_id text, p_fields jsonb, p_actor_user_id text, p_source text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	allowed text[] := ARRAY[
		'provider', 'provider_customer_id', 'provider_subscription_id', 'status', 'seats', 'billing_interval',
		'current_period_start', 'current_period_end', 'trial_ends_at', 'grace_ends_at', 'ai_overage_allowed'
	];
	unknown_keys text[];
	rec public.subscription;
BEGIN
	IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
		RAISE EXCEPTION 'careeros_set_subscription: fields must be a JSON object';
	END IF;
	IF p_source IS NULL OR btrim(p_source) = '' THEN
		RAISE EXCEPTION 'careeros_set_subscription: a source is required';
	END IF;
	SELECT array_agg(k ORDER BY k) INTO unknown_keys FROM jsonb_object_keys(p_fields) AS k WHERE k <> ALL (allowed);
	IF unknown_keys IS NOT NULL THEN
		RAISE EXCEPTION 'careeros_set_subscription: unknown fields %', array_to_string(unknown_keys, ', ');
	END IF;
	PERFORM 1 FROM public.subscription WHERE organization_id = p_org_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'careeros_set_subscription: no subscription for the organization';
	END IF;
	IF p_fields = '{}'::jsonb THEN
		RETURN;
	END IF;
	rec := jsonb_populate_record(NULL::public.subscription, p_fields);
	UPDATE public.subscription s SET
		provider = CASE WHEN p_fields ? 'provider' THEN rec.provider ELSE s.provider END,
		provider_customer_id = CASE WHEN p_fields ? 'provider_customer_id' THEN rec.provider_customer_id ELSE s.provider_customer_id END,
		provider_subscription_id = CASE WHEN p_fields ? 'provider_subscription_id' THEN rec.provider_subscription_id ELSE s.provider_subscription_id END,
		status = CASE WHEN p_fields ? 'status' THEN rec.status ELSE s.status END,
		seats = CASE WHEN p_fields ? 'seats' THEN rec.seats ELSE s.seats END,
		billing_interval = CASE WHEN p_fields ? 'billing_interval' THEN rec.billing_interval ELSE s.billing_interval END,
		current_period_start = CASE WHEN p_fields ? 'current_period_start' THEN rec.current_period_start ELSE s.current_period_start END,
		current_period_end = CASE WHEN p_fields ? 'current_period_end' THEN rec.current_period_end ELSE s.current_period_end END,
		trial_ends_at = CASE WHEN p_fields ? 'trial_ends_at' THEN rec.trial_ends_at ELSE s.trial_ends_at END,
		grace_ends_at = CASE WHEN p_fields ? 'grace_ends_at' THEN rec.grace_ends_at ELSE s.grace_ends_at END,
		ai_overage_allowed = CASE WHEN p_fields ? 'ai_overage_allowed' THEN rec.ai_overage_allowed ELSE s.ai_overage_allowed END,
		updated_at = now()
	WHERE s.organization_id = p_org_id;
	INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_type, target_id, metadata)
	VALUES (p_org_id, p_actor_user_id, 'subscription.updated', 'subscription', p_org_id,
		jsonb_build_object('source', p_source, 'fields', p_fields));
END
$$;
CREATE OR REPLACE FUNCTION public.careeros_billing_due_orgs(p_now timestamptz) RETURNS TABLE (organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT o.id FROM public.organization o JOIN public.subscription s ON s.organization_id = o.id
	WHERE o.status <> 'suspended' AND (
		(o.status = 'trial' AND s.trial_ends_at <= p_now)
		OR (o.status = 'past_due' AND s.grace_ends_at <= p_now)
		OR (s.status = 'canceled' AND coalesce(s.current_period_end, p_now) <= p_now)
	)
	ORDER BY o.id LIMIT 500
$$;
DROP TABLE IF EXISTS "billing_provider_plan";
ALTER TABLE "subscription" DROP CONSTRAINT IF EXISTS "subscription_pending_seats_check";
ALTER TABLE "subscription" DROP COLUMN IF EXISTS "pending_seats";
ALTER TABLE "subscription" DROP COLUMN IF EXISTS "pending_replaces_subscription_id";
