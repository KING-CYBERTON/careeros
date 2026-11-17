-- CAREEROS P3-T09 down migration. Not run by drizzle; run it by hand as the owner role.
-- Restores careeros_audit_platform to its P3-T01 body (no refusal of admin.* actions) and drops the comments. No CASCADE.
CREATE OR REPLACE FUNCTION public.careeros_audit_platform(
	p_actor_user_id text, p_impersonator_user_id text, p_action text, p_target_type text, p_target_id text,
	p_metadata jsonb, p_ip text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	new_id text;
BEGIN
	INSERT INTO public.audit_log (organization_id, actor_user_id, impersonator_user_id, action, target_type, target_id, metadata, ip)
	VALUES (NULL, p_actor_user_id, p_impersonator_user_id, p_action, p_target_type, p_target_id, coalesce(p_metadata, '{}'::jsonb), p_ip)
	RETURNING id INTO new_id;
	RETURN new_id;
END
$$;
COMMENT ON FUNCTION public.careeros_audit_platform(text, text, text, text, text, jsonb, text) IS NULL;
COMMENT ON FUNCTION public.careeros_set_org_plan(text, text, text, text, text) IS NULL;
