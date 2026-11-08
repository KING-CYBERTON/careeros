-- CAREEROS P3-T07 down migration. Not run by drizzle (it only reads migration.sql); run it by hand as the owner role.
-- It drops the Super Admin console's functions and its three tables. The tables hold the announcements, who dismissed
-- them and the record of every impersonation session (the audit_log rows stay, they are not touched here), so this
-- refuses while any of them holds rows, unless the session sets careeros.allow_data_loss = 'yes'.
-- No CASCADE: every dependent object is dropped explicitly and in order.
DO $$ BEGIN
	IF coalesce(current_setting('careeros.allow_data_loss', true), '') <> 'yes' AND (
		EXISTS (SELECT 1 FROM public.announcement)
		OR EXISTS (SELECT 1 FROM public.announcement_dismissal)
		OR EXISTS (SELECT 1 FROM public.impersonation)
	) THEN
		RAISE EXCEPTION 'P3-T07 down refused: announcements or impersonation records exist. SET careeros.allow_data_loss = ''yes'' to drop them.';
	END IF;
END $$;
DROP FUNCTION IF EXISTS public.careeros_impersonation_expire_due();
DROP FUNCTION IF EXISTS public.careeros_impersonation_end(text, text);
DROP FUNCTION IF EXISTS public.careeros_impersonation_for_session(text, text);
DROP FUNCTION IF EXISTS public.careeros_impersonation_active(text, text, text);
DROP FUNCTION IF EXISTS public.careeros_impersonation_attach_session(text, text, text);
DROP FUNCTION IF EXISTS public.careeros_impersonation_redeem(text, text, text, text);
DROP FUNCTION IF EXISTS public.careeros_admin_impersonation_start(text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.careeros_announcement_dismiss(text, text);
DROP FUNCTION IF EXISTS public.careeros_announcements_for_member(text, text);
DROP FUNCTION IF EXISTS public.careeros_admin_announcement_end(text, text);
DROP FUNCTION IF EXISTS public.careeros_admin_announcement_list(text);
DROP FUNCTION IF EXISTS public.careeros_admin_announcement_save(text, text, text, text, text, timestamptz, timestamptz, text, text);
DROP FUNCTION IF EXISTS public.careeros_admin_list_audit(text, text, boolean, text, timestamptz, timestamptz, text, integer);
DROP FUNCTION IF EXISTS public.careeros_admin_metrics(text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.careeros_admin_record_manual_payment(text, text, text, integer, text, timestamptz, timestamptz, bigint, text, text);
DROP FUNCTION IF EXISTS public.careeros_admin_set_ai_overage(text, text, boolean, text);
DROP FUNCTION IF EXISTS public.careeros_admin_set_org_plan(text, text, text, integer, text);
DROP FUNCTION IF EXISTS public.careeros_admin_set_org_status(text, text, text, text);
DROP FUNCTION IF EXISTS public.careeros_admin_get_org(text, text);
DROP FUNCTION IF EXISTS public.careeros_admin_list_orgs(text, text, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.careeros_quota_period(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.careeros_admin_check_reason(text);
DROP FUNCTION IF EXISTS public.careeros_assert_platform_admin(text);
DROP FUNCTION IF EXISTS public.careeros_is_platform_admin(text);
DROP POLICY IF EXISTS "owner_access" ON "impersonation";
DROP POLICY IF EXISTS "owner_access" ON "announcement_dismissal";
DROP POLICY IF EXISTS "owner_access" ON "announcement";
DROP TABLE IF EXISTS "impersonation";
DROP TABLE IF EXISTS "announcement_dismissal";
DROP TABLE IF EXISTS "announcement";
