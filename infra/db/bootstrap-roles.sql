-- CAREEROS: P1-C01 database role split. Single source of truth for the CareerOS database roles.
--
--   careeros_owner  runs migrations; owns schemas `public` and `drizzle` and every table in them.
--   careeros_app    the runtime role: LOGIN, NOSUPERUSER, NOBYPASSRLS, never a table owner, no CREATE,
--                   no access to the `drizzle` schema. Row-level security applies to it.
--
-- Run once per database as a superuser (see infra/db/bootstrap-roles.sh). Idempotent: safe to run any number
-- of times, also against a database that already has tables. Contains no DROP and no hard-coded passwords:
-- both arrive through the session settings `careeros.owner_password` and `careeros.app_password`.

DO $$
DECLARE
	owner_password text := current_setting('careeros.owner_password');
	app_password text := current_setting('careeros.app_password');
BEGIN
	IF owner_password = '' OR app_password = '' THEN
		RAISE EXCEPTION 'careeros.owner_password and careeros.app_password must be set and non-empty';
	END IF;

	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_owner') THEN
		EXECUTE format('CREATE ROLE careeros_owner LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', owner_password);
	ELSE
		EXECUTE format('ALTER ROLE careeros_owner LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', owner_password);
	END IF;

	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		EXECUTE format('CREATE ROLE careeros_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', app_password);
	ELSE
		EXECUTE format('ALTER ROLE careeros_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', app_password);
	END IF;

	EXECUTE format('GRANT CONNECT ON DATABASE %I TO careeros_app', current_database());
	EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO careeros_owner', current_database());
END
$$;

-- Schemas: the owner owns both; the app role can use `public` but cannot create in it or touch `drizzle`.
ALTER SCHEMA public OWNER TO careeros_owner;
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION careeros_owner;
ALTER SCHEMA drizzle OWNER TO careeros_owner;

REVOKE ALL ON SCHEMA drizzle FROM PUBLIC;
REVOKE ALL ON SCHEMA drizzle FROM careeros_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM careeros_app;
GRANT USAGE ON SCHEMA public TO careeros_app;

-- Objects the owner creates later (migrations) are usable by the app role without per-migration grants.
ALTER DEFAULT PRIVILEGES FOR ROLE careeros_owner IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO careeros_app;
ALTER DEFAULT PRIVILEGES FOR ROLE careeros_owner IN SCHEMA public
	GRANT USAGE, SELECT ON SEQUENCES TO careeros_app;

-- Databases that already have objects (for example staging): move ownership to the owner role, no DROP.
DO $$
DECLARE
	obj record;
BEGIN
	FOR obj IN
		SELECT schemaname, tablename FROM pg_tables
		WHERE schemaname IN ('public', 'drizzle') AND tableowner <> 'careeros_owner'
	LOOP
		EXECUTE format('ALTER TABLE %I.%I OWNER TO careeros_owner', obj.schemaname, obj.tablename);
	END LOOP;

	FOR obj IN
		SELECT n.nspname AS schemaname, c.relname AS seqname
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind = 'S' AND n.nspname IN ('public', 'drizzle') AND pg_get_userbyid(c.relowner) <> 'careeros_owner'
	LOOP
		EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO careeros_owner', obj.schemaname, obj.seqname);
	END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO careeros_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO careeros_app;

-- P1-T04: the security definer lookup functions (careeros_*) are executable by the app role only. A migration that ran
-- before this role existed (a fresh test database) could not grant it, so grant here too. Idempotent.
DO $$
DECLARE
	fn record;
BEGIN
	FOR fn IN
		SELECT p.oid::regprocedure AS signature
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'public' AND p.proname LIKE 'careeros\_%'
	LOOP
		EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.signature);
		EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO careeros_app', fn.signature);
	END LOOP;
END
$$;

-- P3-T01: tables the app role must not write. The blanket GRANT above gives it all four privileges on every table, so
-- take them back here, after it, on every run. The row-level security policies of these tables already deny the writes
-- (the migration defines a policy per command); this keeps the grants honest too. plan is read-only, subscription and
-- feature_flag are written only by definer functions and the platform, and audit_log is append-only (INSERT stays).
-- Skipped for tables a database does not have yet (this script can run before the migration).
DO $$
BEGIN
	IF to_regclass('public.plan') IS NOT NULL THEN
		REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.plan FROM careeros_app;
	END IF;
	IF to_regclass('public.subscription') IS NOT NULL THEN
		REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.subscription FROM careeros_app;
	END IF;
	IF to_regclass('public.feature_flag') IS NOT NULL THEN
		REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.feature_flag FROM careeros_app;
	END IF;
	IF to_regclass('public.audit_log') IS NOT NULL THEN
		REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_log FROM careeros_app;
	END IF;
	-- P3-T04: billing_event is reached only through careeros_record_billing_event (a definer function); the app role has
	-- no privilege on the table at all.
	IF to_regclass('public.billing_event') IS NOT NULL THEN
		REVOKE ALL ON TABLE public.billing_event FROM careeros_app;
	END IF;
END
$$;

-- P3-T03: ai_usage is append-only for the app role (SELECT and INSERT stay), like audit_log. Repeated after the blanket
-- GRANT on every run; skipped when the table does not exist yet.
DO $$
BEGIN
	IF to_regclass('public.ai_usage') IS NOT NULL THEN
		REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.ai_usage FROM careeros_app;
	END IF;
END
$$;

-- P3-T07: the Super Admin console's tables are reached only through definer functions (careeros_admin_*,
-- careeros_impersonation_*, careeros_announcement*); the app role has no privilege on them at all. Repeated after the
-- blanket GRANT on every run; skipped for tables a database does not have yet.
DO $$
BEGIN
	IF to_regclass('public.announcement') IS NOT NULL THEN
		REVOKE ALL ON TABLE public.announcement FROM careeros_app;
	END IF;
	IF to_regclass('public.announcement_dismissal') IS NOT NULL THEN
		REVOKE ALL ON TABLE public.announcement_dismissal FROM careeros_app;
	END IF;
	IF to_regclass('public.impersonation') IS NOT NULL THEN
		REVOKE ALL ON TABLE public.impersonation FROM careeros_app;
	END IF;
END
$$;
