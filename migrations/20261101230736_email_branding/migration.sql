ALTER TABLE "organization_branding" ADD COLUMN "email_reply_to" text;--> statement-breakpoint
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_email_reply_to_check" CHECK ("email_reply_to" ~ '^[^@[:space:][:cntrl:]<>,;]+@[^@[:space:][:cntrl:]<>,;]+$');--> statement-breakpoint
-- CAREEROS P2-T04: branded emails (phase plan D8). Everything below the generated DDL is written by hand, following
-- P2-T01, and is idempotent. Runs as the migration (owner) role. Down migration: down.sql in this folder.
--> statement-breakpoint
-- The email sender needs an organization's branding with no session (a password reset, an invitation, a background
-- job), so it reads through a definer function like the public lookups of P2-T01. Unlike those, it also returns
-- email_from_name and email_reply_to. Those two never leave the server: the public API does not return them. It
-- returns one row for a known organization (all branding columns null when it has none) and no row for an unknown one.
-- Pinned search_path; execute is revoked from PUBLIC and granted to careeros_app below.
CREATE OR REPLACE FUNCTION public.careeros_email_branding(org_id text) RETURNS TABLE (
	organization_id text, slug text, app_name text, logo_storage_key text, primary_color text,
	support_url text, terms_url text, privacy_url text, email_from_name text, email_reply_to text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT o.id, o.slug, b.app_name, b.logo_storage_key, b.primary_color, b.support_url, b.terms_url, b.privacy_url,
		b.email_from_name, b.email_reply_to
	FROM public.organization o LEFT JOIN public.organization_branding b ON b.organization_id = o.id
	WHERE o.id = $1
$$;--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_email_branding(text) FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_email_branding(text) TO careeros_app;
	END IF;
END $$;
