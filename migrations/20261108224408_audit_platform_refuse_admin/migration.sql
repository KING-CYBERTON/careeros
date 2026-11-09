-- CAREEROS P3-T09 (Q422): careeros_audit_platform stays callable by careeros_app, because billing transitions and the
-- webhooks write platform rows through it with no user actor. It now refuses any action that starts with `admin.`
-- (SQLSTATE 42501) and writes nothing: only the Super Admin console's definer functions write `admin.*` rows, through
-- their own INSERT, after checking the actor is a platform admin. Without this, anyone able to run SQL as the app role
-- could forge a row that looks like a console action.
-- careeros_set_org_plan and careeros_set_subscription are unchanged: billing calls them with a NULL actor for system
-- transitions by design.
CREATE OR REPLACE FUNCTION public.careeros_audit_platform(
	p_actor_user_id text, p_impersonator_user_id text, p_action text, p_target_type text, p_target_id text,
	p_metadata jsonb, p_ip text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	new_id text;
BEGIN
	IF p_action LIKE 'admin.%' THEN
		RAISE EXCEPTION 'careeros_audit_platform may not write console (admin.*) actions' USING ERRCODE = '42501';
	END IF;
	INSERT INTO public.audit_log (organization_id, actor_user_id, impersonator_user_id, action, target_type, target_id, metadata, ip)
	VALUES (NULL, p_actor_user_id, p_impersonator_user_id, p_action, p_target_type, p_target_id, coalesce(p_metadata, '{}'::jsonb), p_ip)
	RETURNING id INTO new_id;
	RETURN new_id;
END
$$;--> statement-breakpoint
COMMENT ON FUNCTION public.careeros_audit_platform(text, text, text, text, text, jsonb, text) IS
	'Writes a platform-level audit row for billing and webhooks (no user actor). Refuses admin.* actions (42501): only the console definer functions write those.';--> statement-breakpoint
COMMENT ON FUNCTION public.careeros_set_org_plan(text, text, text, text, text) IS
	'Billing calls this with a NULL actor for system transitions by design (P3-T09, Q422). The console reaches it through careeros_admin_set_org_plan, which checks the actor.';--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_audit_platform(text, text, text, text, text, jsonb, text) FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_audit_platform(text, text, text, text, text, jsonb, text) TO careeros_app;
	END IF;
END $$;
