# P1-C01 — Database role split (migration owner vs app role)

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 3 CI/CD · **Phase plan:** [../P1-PHASE-PLAN.md](../P1-PHASE-PLAN.md) (D3, D4, D8) · **Depends on:** P0-C01, P0-C03

## Goal

The app runs as `careeros_app` (LOGIN, NOSUPERUSER, NOBYPASSRLS, not the table owner) and migrations run as a separate owner role, in CI e2e, in the staging stack and in `.env.example` docs. RLS (added in P1-T04+) only works if this split is in place first.

## Changes

1. **Bootstrap SQL** `infra/db/bootstrap-roles.sql` (idempotent, run by a superuser once per database):
   - Create or normalise `careeros_owner` (LOGIN, NOSUPERUSER, NOBYPASSRLS, password from session setting `careeros.owner_password`) and `careeros_app` (as today's `packages/careeros-testing/sql/create-app-role.sql`, password from `careeros.app_password`).
   - `careeros_owner` owns schema `public` and the `drizzle` schema (create it if missing) and gets `CREATE` on the database.
   - `ALTER DEFAULT PRIVILEGES FOR ROLE careeros_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO careeros_app;` and `GRANT USAGE, SELECT ON SEQUENCES`; `GRANT USAGE ON SCHEMA public TO careeros_app`.
   - For a database that already has tables (staging today): `REASSIGN OWNED`-free path: `ALTER TABLE ... OWNER TO careeros_owner` for every table in `public` and `drizzle`, then the same grants on existing tables and sequences. Do this in a `DO` block over `pg_tables`; no `DROP`.
   - `careeros_app` gets no `CREATE` on `public` and no access to the `drizzle` schema.
2. **Runner script** `infra/db/bootstrap-roles.sh`: `psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1` with the two passwords passed via `PGOPTIONS='-c careeros.owner_password=… -c careeros.app_password=…'` from env vars `CAREEROS_OWNER_PASSWORD` / `CAREEROS_APP_PASSWORD`; never echoed.
3. **CI** (`careeros-ci.yml`, job `e2e`): after Postgres starts, run the bootstrap with fixed CI-only passwords (public CI values are fine, same as today's `careeros_app` test password); set `DATABASE_MIGRATION_URL` to the `careeros_owner` URL and `DATABASE_URL` to the `careeros_app` URL for `db:migrate`, build and Playwright. `db:migrate` must use the migration URL (check the root script and `drizzle.config`; if it reads only `DATABASE_URL`, run that step with `DATABASE_URL` overridden to the owner URL for that step only). Unit job: unchanged except that `db:test-role` may call the shared bootstrap SQL instead of its own copy (keep one source of truth; the testing package's SQL becomes a thin include or is removed with its script updated).
4. **Staging** (`infra/staging/`): add `CAREEROS_OWNER_PASSWORD`/`CAREEROS_APP_PASSWORD` placeholders to `.env.staging.example`; app `.env` uses `DATABASE_URL=postgresql://careeros_app:…@postgres:5432/postgres` and `DATABASE_MIGRATION_URL=postgresql://careeros_owner:…@postgres:5432/postgres`. Add a one-shot compose service `db_bootstrap` (postgres image, runs `bootstrap-roles.sql` with the superuser `POSTGRES_PASSWORD`, `restart: "no"`), and make `app` depend on it with `service_completed_successfully`. Runbook section "Database roles" explains it.
5. **Docs**: `.env.example` comments explain the two URLs (upstream file → `# CAREEROS:` comment + UPSTREAM_PATCHES row). `docs/plans/cicd/P0-CICD-PLAN.md` is Opus's; do not edit it.

## Out of scope

RLS policies (P1-T04+), tenancy middleware (P1-T02), any change to upstream migration files.

## Acceptance

- CI green with e2e running the app as `careeros_app` and migrations as `careeros_owner`. Add an assertion step in e2e after server start: `psql` as `careeros_app` shows `current_user = careeros_app`, `rolsuper = false`, `rolbypassrls = false`, and that `careeros_app` owns no table in `public` (query `pg_tables`).
- Bootstrap SQL runs twice in a row without error (CI runs it twice).
- No secrets committed; passwords only via env/session settings.
- Every upstream file touched is listed in `docs/UPSTREAM_PATCHES.md`.
