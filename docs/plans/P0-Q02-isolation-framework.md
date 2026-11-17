# P0-Q02 — Tenant isolation test framework

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 2 QA & Testing · **Depends on:** P0-Q01, P0-C01 · **Test plan:** [../test-plans/P0-Q02.md](../test-plans/P0-Q02.md)

## Goal

From Phase 1 on, adding a tenant table means adding one registry entry, and CI then proves (PRODUCT.md §6.3) that Org B can never see Org A's rows through the DB or the API. In Phase 0 the framework exists and proves it can catch a leak.

## Design

Package `packages/isolation-testing`, name `@careeros/isolation-testing`, depends on `@careeros/testing`.

1. **Registry** `src/registry.ts`: a typed list of entries `{ table, schema (default "public"), seed(orgId, db) → inserted row id, api?: { list(orgSession), get(orgSession, id) } }`. Phase 0 ships it **empty** (exported constant), with a type that later phases fill.
2. **DB isolation check** `src/db-check.ts`: for each entry: seed one row for Org A with the owner connection; then on the app connection (`careeros_app`, non-superuser) inside a transaction with `app.current_org_id = Org B`, select all rows → must be 0; select by the seeded id → must be 0; with `app.current_org_id = Org A` → must be exactly 1 (proves the row exists and RLS isn't just hiding everything).
3. **Coverage check** `src/coverage-check.ts`: query `information_schema.columns` + `pg_class.relrowsecurity` / `relforcerowsecurity` for every table in the target schema that has an `organization_id` column. Fail if such a table (a) is not in the registry, or (b) does not have RLS enabled, or (c) has no policy in `pg_policies`.
4. **API ID-fuzz helper** `src/api-check.ts`: given an entry with `api`, seed in Org A, call `get` as Org B with Org A's id → expect 404 (not 403, not 200); call `list` as Org B → id absent. In Phase 0 this is exercised only by the self-test with a fake API object (no real endpoints yet).
5. **Runner** `src/run.ts` exposes a function that generates one Vitest `describe` per registry entry, so the suite grows automatically.
6. **Self-tests** `src/self-test.test.ts` use a throwaway schema created per run (via `@careeros/testing`) containing:
   - `iso_good`: `organization_id text not null` (upstream and Better Auth ids are text, see P0-UPSTREAM-INVENTORY F1), RLS enabled + FORCE, policy `tenant_isolation USING (organization_id = current_setting('app.current_org_id', true))` → all checks pass.
   - `iso_leaky`: same columns, **no** RLS → DB check and coverage check must **fail** (assert the failure is reported, test passes).
   - `iso_unregistered`: has RLS but is not in the test registry → coverage check must report it.
   - A fake API that returns the row regardless of org → API check must fail; a correct fake → passes.
     The schema is dropped after the run.

## Rules

- All isolation checks run on the `careeros_app` connection. A test that would run reads as superuser must throw. Check at start: `select rolsuper, rolbypassrls from pg_roles where rolname = current_user` must be false/false, else fail with a clear message.
- With the `missing_ok` form of `current_setting`, querying `iso_good` with no org set must return 0 rows. Self-test asserts exactly that.

## Acceptance criteria

- `pnpm --filter @careeros/isolation-testing test:ci` passes in CI, including all negative self-tests.
- The coverage check against the real `public` schema passes (no upstream table has `organization_id` yet) — this becomes a guard in Phase 1.
- README in the package explains in ≤ 1 page how to register a new table.
