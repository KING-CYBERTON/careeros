# P0-Q01 — Test harness conventions and CareerOS scaffolding

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 2 QA & Testing · **Depends on:** P0-T01 · **Test plan:** [../test-plans/P0-Q01.md](../test-plans/P0-Q01.md)

## Goal
CareerOS tests plug into the existing upstream harness (Vitest via Vite+, Playwright) without editing upstream test config, and there is one place for shared CareerOS test helpers.

## Decisions
- Reuse upstream harness. No Jest, no second Playwright config.
- Unit/integration tests live next to the code in each `@careeros/*` package as `*.test.ts`, run by that package's `test` / `test:ci` scripts so `turbo run test:ci` picks them up.
- New package `packages/careeros-testing`, name `@careeros/testing`, private, source-consumed (export map to `src`, same pattern as upstream internal packages). Turbo tags: follow the tag style of an upstream server-side package such as `@reactive-resume/db` (check its `package.json`/`turbo.json`) so boundaries pass.
- CareerOS e2e specs go in the existing `tests/e2e/specs/` folder with the file prefix `careeros-` and reuse fixtures from `tests/e2e/fixtures`.

## Files
- `packages/careeros-testing/package.json`, `tsconfig.json`, `vitest.config.ts` (copy the shape of an upstream package that has DB-backed tests, e.g. find one whose tests use `*_TEST_DATABASE_URL`), `src/index.ts`.
- `src/env.ts`: reads `CAREEROS_TEST_DATABASE_URL` (owner/superuser connection, used only for setup) and `CAREEROS_TEST_APP_DATABASE_URL` (non-superuser connection); throws a clear error naming the missing variable.
- `src/db.ts`: helpers to (a) open a pool for each URL, (b) create and drop a uniquely named schema per test file, (c) run a callback inside a transaction with `SELECT set_config('app.current_org_id', $1, true)` (transaction-local; `SET LOCAL` cannot take bind parameters) on the **app** connection.
- `src/ids.ts`: helper returning two random org ids (A and B) as text strings, in the same id format upstream uses for primary keys (check `packages/db/src/schema/auth.ts` defaults; if unclear, log a question).
- `src/index.test.ts`: tests for the helpers (see test plan).
- `tests/e2e/specs/careeros-smoke.spec.ts`: signs up a fresh user through the UI and sees the dashboard (reuse upstream auth fixture). This proves CareerOS e2e specs run in the existing pipeline.
- Root `.env.example`: append both variables with placeholder values and a `# CAREEROS:` comment; log in `docs/UPSTREAM_PATCHES.md`.

## Non-superuser role
The test setup must create (if missing) a role `careeros_app` with `LOGIN NOSUPERUSER NOBYPASSRLS` and grant it usage on test schemas. Provide this as a SQL file `packages/careeros-testing/sql/create-app-role.sql` executed by a package script `db:test-role`, using the owner URL. Password comes from an env var, never hard-coded except the public CI fixture value already used upstream style (document it as a disposable CI value).

## Acceptance criteria
- `pnpm --filter @careeros/testing test:ci` passes locally and in CI with both env vars set.
- `turbo boundaries`, `lint`, `typecheck` pass.
- `careeros-smoke.spec.ts` passes in the e2e run.
- No upstream test config file edited.
