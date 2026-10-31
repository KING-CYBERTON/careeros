-- Creates (or normalises) the non-superuser role that CareerOS tests connect as.
-- Run by `pnpm --filter @careeros/testing db:test-role` over the owner connection.
-- The password arrives through the session setting `careeros.app_password`; it is never hard-coded here.
-- Idempotent: safe to run any number of times.
DO $$
DECLARE
	app_password text := current_setting('careeros.app_password');
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careeros_app') THEN
		EXECUTE format('CREATE ROLE careeros_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', app_password);
	ELSE
		EXECUTE format('ALTER ROLE careeros_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', app_password);
	END IF;
	EXECUTE format('GRANT CONNECT ON DATABASE %I TO careeros_app', current_database());
END
$$;
