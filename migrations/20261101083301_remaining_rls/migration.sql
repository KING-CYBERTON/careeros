-- CAREEROS P1-T09: custom_domain, storage_cleanup_job and web_access_credentials join the tenant boundary (D4, D10, D11),
-- following P1-T04 and P1-T05. Every statement is idempotent so the migration can run twice. Runs as the migration
-- (owner) role. Down migration: down.sql in this folder (it refuses when it would lose data).
--> statement-breakpoint
-- 1. D7 safety net: a user with a custom domain, a web connection or erasure work but no membership still gets a
-- personal organization, so the NOT NULL below cannot fail. Same ids and marker as the T04 and T05 backfill.
INSERT INTO "organization" ("id", "name", "slug", "metadata")
SELECT
	'bf_' || md5(u."id"),
	CASE WHEN coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) IS NULL THEN 'Personal workspace'
		ELSE left(coalesce(nullif(btrim(u."name"), ''), nullif(btrim(u."username"), '')) || '''s workspace', 100) END,
	'u-' || right(md5(u."id"), 16),
	'{"careeros_backfill":true}'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
	AND (EXISTS (SELECT 1 FROM "custom_domain" d WHERE d."user_id" = u."id")
		OR EXISTS (SELECT 1 FROM "web_access_credentials" w WHERE w."user_id" = u."id")
		OR EXISTS (SELECT 1 FROM "storage_cleanup_job" j WHERE j."owner_id" = u."id"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "member" ("id", "organization_id", "user_id", "role")
SELECT 'bf_' || md5(u."id"), 'bf_' || md5(u."id"), u."id", 'owner'
FROM "user" u
WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."user_id" = u."id")
	AND (EXISTS (SELECT 1 FROM "custom_domain" d WHERE d."user_id" = u."id")
		OR EXISTS (SELECT 1 FROM "web_access_credentials" w WHERE w."user_id" = u."id")
		OR EXISTS (SELECT 1 FROM "storage_cleanup_job" j WHERE j."owner_id" = u."id"))
	AND EXISTS (SELECT 1 FROM "organization" o WHERE o."id" = 'bf_' || md5(u."id"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 2. organization_id: nullable first, backfilled from the owner's oldest membership, then NOT NULL.
ALTER TABLE "custom_domain" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "web_access_credentials" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "storage_cleanup_job" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
UPDATE "custom_domain" d
SET "organization_id" = (
	SELECT m."organization_id" FROM "member" m WHERE m."user_id" = d."user_id" ORDER BY m."created_at", m."id" LIMIT 1
)
WHERE d."organization_id" IS NULL;--> statement-breakpoint
UPDATE "web_access_credentials" w
SET "organization_id" = (
	SELECT m."organization_id" FROM "member" m WHERE m."user_id" = w."user_id" ORDER BY m."created_at", m."id" LIMIT 1
)
WHERE w."organization_id" IS NULL;--> statement-breakpoint
-- storage_cleanup_job has no user foreign key, so its owner may be gone. An existing owner takes the oldest membership,
-- falling back to the personal organization id rule above. A vanished owner gets the sentinel organization
-- 'careeros_orphan': it has no organization row and no foreign key, and the worker processes it like any other.
UPDATE "storage_cleanup_job" j
SET "organization_id" = coalesce(
	(SELECT m."organization_id" FROM "member" m WHERE m."user_id" = j."owner_id" ORDER BY m."created_at", m."id" LIMIT 1),
	CASE WHEN EXISTS (SELECT 1 FROM "user" u WHERE u."id" = j."owner_id") THEN 'bf_' || md5(j."owner_id") END,
	'careeros_orphan'
)
WHERE j."organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "custom_domain" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "web_access_credentials" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_cleanup_job" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_domain_organization_id_organization_id_fkey' AND conrelid = '"custom_domain"'::regclass) THEN
		ALTER TABLE "custom_domain" ADD CONSTRAINT "custom_domain_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'web_access_credentials_organization_id_organization_id_fkey' AND conrelid = '"web_access_credentials"'::regclass) THEN
		ALTER TABLE "web_access_credentials" ADD CONSTRAINT "web_access_credentials_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
	END IF;
END $$;--> statement-breakpoint
-- 3. Keys become organization-led (D11). Guarded so a second run does not rebuild them.
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = '"custom_domain"'::regclass AND c.contype = 'p' AND cardinality(c.conkey) = 2) THEN
		ALTER TABLE "custom_domain" DROP CONSTRAINT "custom_domain_pkey";
		ALTER TABLE "custom_domain" ADD PRIMARY KEY ("organization_id", "user_id");
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = '"web_access_credentials"'::regclass AND c.contype = 'p' AND cardinality(c.conkey) = 2) THEN
		ALTER TABLE "web_access_credentials" DROP CONSTRAINT "web_access_credentials_pkey";
		ALTER TABLE "web_access_credentials" ADD PRIMARY KEY ("organization_id", "user_id");
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'storage_cleanup_job_owner_key_unique' AND c.conrelid = '"storage_cleanup_job"'::regclass AND cardinality(c.conkey) = 3) THEN
		ALTER TABLE "storage_cleanup_job" DROP CONSTRAINT "storage_cleanup_job_owner_key_unique";
		ALTER TABLE "storage_cleanup_job" ADD CONSTRAINT "storage_cleanup_job_owner_key_unique" UNIQUE ("organization_id", "owner_id", "storage_key");
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_cleanup_job_org_due_index" ON "storage_cleanup_job" ("organization_id","status","next_attempt_at") WHERE "status" = 'pending';--> statement-breakpoint
-- 4. Row-level security (D4), exactly as P1-T04: FORCE applies the policy to the table owner too, so only owner_access
-- lets the owner role (migrations, definer functions) see every organization. careeros_app only matches its own
-- organization; an unset setting is NULL and matches nothing (fail closed).
ALTER TABLE "custom_domain" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "custom_domain" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "custom_domain";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "custom_domain"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "custom_domain";--> statement-breakpoint
CREATE POLICY "owner_access" ON "custom_domain" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "web_access_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "web_access_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "web_access_credentials";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "web_access_credentials"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "web_access_credentials";--> statement-breakpoint
CREATE POLICY "owner_access" ON "web_access_credentials" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "storage_cleanup_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storage_cleanup_job" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "storage_cleanup_job";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "storage_cleanup_job"
	USING ("organization_id" = current_setting('app.current_org_id', true))
	WITH CHECK ("organization_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "owner_access" ON "storage_cleanup_job";--> statement-breakpoint
CREATE POLICY "owner_access" ON "storage_cleanup_job" TO CURRENT_USER USING (true) WITH CHECK (true);--> statement-breakpoint
-- 5. Public custom domain lookups run without an organization (D10, Q31). Each function answers only for a VERIFIED
-- domain and returns the minimum: the owner of a hostname, the hostnames Traefik routes, and one user's public
-- hostname. Pinned search_path; execute is revoked from PUBLIC and granted to careeros_app below.
CREATE OR REPLACE FUNCTION public.careeros_public_domain_owner(hostname text) RETURNS TABLE (user_id text, organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT d.user_id, d.organization_id FROM public.custom_domain d
	WHERE d.hostname = lower($1) AND d.verified_at IS NOT NULL
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.careeros_verified_domains() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT d.hostname FROM public.custom_domain d WHERE d.verified_at IS NOT NULL ORDER BY d.hostname
$$;--> statement-breakpoint
-- The verified hostname of one user (the oldest verification if several organizations hold one): where that user's
-- primary resume lives for search engines.
CREATE OR REPLACE FUNCTION public.careeros_public_verified_domain(for_user text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT d.hostname FROM public.custom_domain d
	WHERE d.user_id = $1 AND d.verified_at IS NOT NULL
	ORDER BY d.verified_at, d.organization_id LIMIT 1
$$;--> statement-breakpoint
-- Proof of DNS ownership moves a hostname from any other claimant. The other claimants are in other organizations and
-- invisible under row-level security, and the verified-hostname unique index is global, so this un-verifies them. It
-- only acts for the caller's own organization (app.current_org_id must equal keep_org).
CREATE OR REPLACE FUNCTION public.careeros_release_domain_claims(for_hostname text, keep_org text, keep_user text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	IF keep_org IS DISTINCT FROM nullif(current_setting('app.current_org_id', true), '') THEN
		RAISE EXCEPTION 'careeros_release_domain_claims: the organization is not the current one';
	END IF;
	UPDATE public.custom_domain SET verified_at = NULL
	WHERE hostname = for_hostname AND verified_at IS NOT NULL
		AND NOT (organization_id = keep_org AND user_id = keep_user);
END
$$;--> statement-breakpoint
-- D9 background job: the (user, organization) pairs whose verified domain is due a DNS re-check. No row data.
CREATE OR REPLACE FUNCTION public.careeros_stale_custom_domains(cutoff timestamptz, max_rows integer) RETURNS TABLE (user_id text, organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT d.user_id, d.organization_id FROM public.custom_domain d
	WHERE d.verified_at IS NOT NULL AND (d.last_checked_at IS NULL OR d.last_checked_at < $1)
	ORDER BY d.last_checked_at NULLS FIRST, d.organization_id, d.user_id
	LIMIT $2
$$;--> statement-breakpoint
-- 6. Storage cleanup worker (D9): the ids and organizations of due jobs, nothing else. The worker then claims,
-- acknowledges and fences each one inside withOrgContext. The optional filters narrow a run to one owner, some keys or
-- one organization (an immediate pass after a delete, inside that request's organization).
CREATE OR REPLACE FUNCTION public.careeros_due_storage_cleanup(now_at timestamptz, max_rows integer, for_owner text DEFAULT NULL, for_keys text[] DEFAULT NULL, for_org text DEFAULT NULL)
RETURNS TABLE (id text, organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT j.id, j.organization_id FROM public.storage_cleanup_job j
	WHERE j.status = 'pending' AND j.next_attempt_at <= $1
		AND ($3 IS NULL OR j.owner_id = $3)
		AND ($4 IS NULL OR j.storage_key = ANY($4))
		AND ($5 IS NULL OR j.organization_id = $5)
	ORDER BY j.next_attempt_at, j.id
	LIMIT $2
$$;--> statement-breakpoint
-- The account delete trigger now runs as the owner: the deleting request has no organization (or not the one this
-- work belongs to), and the row must be written whatever happens. The job takes the request's organization when there
-- is one, else the sentinel 'careeros_orphan'. Like owner_id it has no foreign key, so it survives the account and
-- its organizations. Narrower jobs of every organization are replaced by the one account-prefix job.
CREATE OR REPLACE FUNCTION public.enqueue_account_storage_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
	DELETE FROM public.storage_cleanup_job WHERE owner_id = OLD.id;
	INSERT INTO public.storage_cleanup_job (id, organization_id, owner_id, storage_key)
	VALUES (OLD.id || ':account', coalesce(nullif(current_setting('app.current_org_id', true), ''), 'careeros_orphan'), OLD.id, 'uploads/' || OLD.id)
	ON CONFLICT (organization_id, owner_id, storage_key) DO NOTHING;
	RETURN OLD;
END;
$$;--> statement-breakpoint
-- 7. Guest linking: the guest's pending erasure prefixes are excluded from the copy. They live in the guest's
-- organizations, invisible to the linking request, so this returns the storage keys of an anonymous user's jobs.
CREATE OR REPLACE FUNCTION public.careeros_guest_cleanup_prefixes(from_user text) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
	SELECT j.storage_key FROM public.storage_cleanup_job j
	WHERE j.owner_id = $1 AND EXISTS (SELECT 1 FROM public."user" u WHERE u.id = $1 AND u.is_anonymous)
$$;--> statement-breakpoint
DO $$ BEGIN
	REVOKE ALL ON FUNCTION public.careeros_public_domain_owner(text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_verified_domains() FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_public_verified_domain(text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_release_domain_claims(text, text, text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_stale_custom_domains(timestamptz, integer) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_due_storage_cleanup(timestamptz, integer, text, text[], text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.careeros_guest_cleanup_prefixes(text) FROM PUBLIC;
	REVOKE ALL ON FUNCTION public.enqueue_account_storage_cleanup() FROM PUBLIC;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		GRANT EXECUTE ON FUNCTION public.careeros_public_domain_owner(text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_verified_domains() TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_public_verified_domain(text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_release_domain_claims(text, text, text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_stale_custom_domains(timestamptz, integer) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_due_storage_cleanup(timestamptz, integer, text, text[], text) TO careeros_app;
		GRANT EXECUTE ON FUNCTION public.careeros_guest_cleanup_prefixes(text) TO careeros_app;
	END IF;
END $$;
