CREATE TABLE "organization_domain" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"hostname" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verification_token" text NOT NULL,
	"cf_custom_hostname_id" text,
	"cf_ssl_status" text,
	"last_checked_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"failure_reason" text,
	"txt_missing_count" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "organization_domain_status_check" CHECK ("status" in ('pending', 'verified', 'active', 'failed', 'removing')),
	CONSTRAINT "organization_domain_hostname_check" CHECK ("hostname" = lower("hostname"))
);
--> statement-breakpoint
CREATE TABLE "organization_domain_cf_cleanup" (
	"cf_custom_hostname_id" text PRIMARY KEY,
	"hostname" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_domain_hostname_key" ON "organization_domain" ("hostname");--> statement-breakpoint
CREATE INDEX "organization_domain_org_created_idx" ON "organization_domain" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "organization_domain_status_checked_idx" ON "organization_domain" ("status","last_checked_at");--> statement-breakpoint
ALTER TABLE "organization_domain" ADD CONSTRAINT "organization_domain_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_domain" ADD CONSTRAINT "organization_domain_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
-- CAREEROS P2-T06: organization custom domains (phase plan D3, D7). Everything below the generated DDL is written by
-- hand, following P1-T09 and P2-T01, and is idempotent (the generated DDL above is not). Runs as the migration (owner)
-- role. Down migration: down.sql in this folder.
--> statement-breakpoint
-- 1. Row-level security (D4), exactly as P1-T04: FORCE applies the policy to the table owner too, so only owner_access
-- lets the owner role (migrations, definer functions) see every organization. careeros_app only matches its own
-- organization; an unset setting is NULL and matches nothing (fail closed).
ALTER TABLE "organization_domain" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_domain" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_domain";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organization_domain"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "organization_domain";--> statement-breakpoint
CREATE POLICY "owner_access" ON "organization_domain" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
-- 2. Claim a hostname for an organization (D7). One hostname has one owner across BOTH kinds of custom domain: the
-- organization_domain unique index covers organization against organization, and this function adds the per-user
-- custom_domain table (invisible under row-level security, so only a definer function can look) and the platform's own
-- hosts. It runs as the owner and acts only for the caller's own organization (app.current_org_id must equal org_id).
-- Two locks make concurrent claims safe: one on the hostname (the custom_domain trigger below takes the same one) and
-- one on the organization (the cap of five). Failures carry a stable message for the service to map:
-- careeros_org_domain:{invalid_hostname|reserved_host|hostname_taken|domain_limit}. The message never says who holds
-- a hostname that is taken.
CREATE OR REPLACE FUNCTION public.careeros_claim_org_domain(
	org_id text, domain_id text, host text, token text, actor text,
	reserved_hosts text[] DEFAULT NULL, pattern_prefix text DEFAULT NULL, pattern_suffix text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
	h text := lower(host);
	reserved text;
BEGIN
	IF org_id IS DISTINCT FROM nullif(current_setting('app.current_org_id', true), '') THEN
		RAISE EXCEPTION 'careeros_claim_org_domain: the organization is not the current one';
	END IF;
	IF length(h) > 253 OR h !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' THEN
		RAISE EXCEPTION 'careeros_org_domain:invalid_hostname';
	END IF;
	PERFORM pg_advisory_xact_lock(hashtext(h));
	PERFORM pg_advisory_xact_lock(hashtext('careeros:org_domain_cap:' || org_id));
	-- The platform host, its aliases and the custom-domain target, and anything under them.
	IF reserved_hosts IS NOT NULL THEN
		FOREACH reserved IN ARRAY reserved_hosts LOOP
			reserved := lower(reserved);
			IF reserved <> '' AND (h = reserved OR right(h, length(reserved) + 1) = '.' || reserved) THEN
				RAISE EXCEPTION 'careeros_org_domain:reserved_host';
			END IF;
		END LOOP;
	END IF;
	-- Anything with the shape of an organization host (a superset of ORG_HOST_PATTERN: the same prefix and suffix, any middle).
	IF coalesce(pattern_prefix, '') <> '' OR coalesce(pattern_suffix, '') <> '' THEN
		IF length(h) > length(coalesce(pattern_prefix, '')) + length(coalesce(pattern_suffix, ''))
			AND left(h, length(coalesce(pattern_prefix, ''))) = coalesce(pattern_prefix, '')
			AND right(h, length(coalesce(pattern_suffix, ''))) = coalesce(pattern_suffix, '') THEN
			RAISE EXCEPTION 'careeros_org_domain:reserved_host';
		END IF;
	END IF;
	IF EXISTS (SELECT 1 FROM public.organization_domain WHERE hostname = h)
		OR EXISTS (SELECT 1 FROM public.custom_domain WHERE hostname = h) THEN
		RAISE EXCEPTION 'careeros_org_domain:hostname_taken';
	END IF;
	IF (SELECT count(*) FROM public.organization_domain WHERE organization_id = org_id) >= 5 THEN
		RAISE EXCEPTION 'careeros_org_domain:domain_limit';
	END IF;
	INSERT INTO public.organization_domain (id, organization_id, hostname, status, verification_token, created_by)
	VALUES (domain_id, org_id, h, 'pending', token, actor);
	RETURN domain_id;
END
$$;--> statement-breakpoint
-- 3. The reverse check (D7): the upstream per-user custom_domain table refuses a hostname that an organization holds.
-- A trigger, so every way of writing a hostname is covered, and it takes the same hostname lock as the claim above, so
-- the two kinds of claim cannot both succeed for one name.
CREATE OR REPLACE FUNCTION public.careeros_custom_domain_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.hostname IS NOT DISTINCT FROM OLD.hostname THEN
		RETURN NEW;
	END IF;
	PERFORM pg_advisory_xact_lock(hashtext(lower(NEW.hostname)));
	IF EXISTS (SELECT 1 FROM public.organization_domain WHERE hostname = lower(NEW.hostname)) THEN
		RAISE EXCEPTION 'careeros_org_domain:hostname_taken';
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "careeros_custom_domain_guard" ON "custom_domain";--> statement-breakpoint
CREATE TRIGGER "careeros_custom_domain_guard" BEFORE INSERT OR UPDATE OF "hostname" ON "custom_domain"
	FOR EACH ROW EXECUTE FUNCTION public.careeros_custom_domain_guard();--> statement-breakpoint
-- 4. Host lookup (T03's customDomainOrg hook). Only an ACTIVE domain resolves: pending, verified, failed and removing
-- answer no row. Returns the organization id and slug, nothing else.
CREATE OR REPLACE FUNCTION public.careeros_org_for_custom_host(hostname text) RETURNS TABLE (organization_id text, slug text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT d.organization_id, o.slug FROM public.organization_domain d
	JOIN public.organization o ON o.id = d.organization_id
	WHERE d.hostname = lower($1) AND d.status = 'active'
$$;--> statement-breakpoint
-- Whether any organization holds this hostname, in any status. The resolver answers 404 for such a host that is not
-- active, rather than treating it as the platform host (fail closed). A boolean only.
CREATE OR REPLACE FUNCTION public.careeros_org_domain_is_registered(hostname text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT EXISTS (SELECT 1 FROM public.organization_domain d WHERE d.hostname = lower($1))
$$;--> statement-breakpoint
-- 5. Q94: whether an organization lets anyone join. A boolean for the join-or-switch page, answered without opening
-- a scope for an organization the caller is not a member of.
CREATE OR REPLACE FUNCTION public.careeros_org_open_signup(org_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT coalesce((SELECT s.open_signup FROM public.organization_settings s WHERE s.organization_id = $1), false)
$$;--> statement-breakpoint
-- 6. Polling job (D9 pattern): the ids and organizations of domains that are due, nothing else. The job then takes each
-- one inside withOrgContext. Database time throughout. Pending, verified and removing rows are due every 5 minutes,
-- active ones every 24 hours; failed ones never.
CREATE OR REPLACE FUNCTION public.careeros_org_domains_due(max_rows integer) RETURNS TABLE (id text, organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT d.id, d.organization_id FROM public.organization_domain d
	WHERE (d.status IN ('pending', 'verified', 'removing') AND (d.last_checked_at IS NULL OR d.last_checked_at <= now() - interval '5 minutes'))
		OR (d.status = 'active' AND (d.last_checked_at IS NULL OR d.last_checked_at <= now() - interval '24 hours'))
	ORDER BY d.last_checked_at NULLS FIRST, d.created_at, d.id
	LIMIT $1
$$;--> statement-breakpoint
-- 7. Deleting an organization cascades to its domains. A row that still names a Cloudflare hostname leaves that
-- hostname in the queue so the polling job deletes it at Cloudflare. The service clears the id after a successful
-- Cloudflare delete, so a normal removal queues nothing.
CREATE OR REPLACE FUNCTION public.careeros_org_domain_cf_cleanup_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	INSERT INTO public.organization_domain_cf_cleanup (cf_custom_hostname_id, hostname)
	VALUES (OLD.cf_custom_hostname_id, OLD.hostname) ON CONFLICT DO NOTHING;
	RETURN OLD;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "careeros_org_domain_cf_cleanup" ON "organization_domain";--> statement-breakpoint
CREATE TRIGGER "careeros_org_domain_cf_cleanup" AFTER DELETE ON "organization_domain"
	FOR EACH ROW WHEN (OLD.cf_custom_hostname_id IS NOT NULL)
	EXECUTE FUNCTION public.careeros_org_domain_cf_cleanup_enqueue();--> statement-breakpoint
-- 8. Execute is revoked from PUBLIC and granted to careeros_app (the same pattern as every careeros_* function). The
-- trigger functions are never called directly.
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_claim_org_domain(text, text, text, text, text, text[], text, text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_custom_domain_guard() FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_org_for_custom_host(text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_org_domain_is_registered(text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_org_open_signup(text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_org_domains_due(integer) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_org_domain_cf_cleanup_enqueue() FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_claim_org_domain(text, text, text, text, text, text[], text, text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_org_for_custom_host(text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_org_domain_is_registered(text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_org_open_signup(text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_org_domains_due(integer) TO careeros_app;
	END IF;
END $$;
