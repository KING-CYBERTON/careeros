# @careeros/isolation-testing

Proves that Org B can never see Org A's rows. Adding a tenant table means adding one registry entry; CI does the rest.

## Register a new tenant table

1. The table needs `organization_id text not null` (ids are text, see P0-UPSTREAM-INVENTORY F1), RLS enabled and forced, and the policy
   `CREATE POLICY tenant_isolation ON <table> USING (organization_id = current_setting('app.current_org_id', true))`.
2. Add an entry to `isolationRegistry` in `src/registry.ts`:

```ts
{
  table: "cover_letter",          // required
  schema: "public",               // optional, default "public"
  idColumn: "id",                 // optional, default "id"
  seed: async (orgId, db) => {    // insert one row for orgId using the owner pool; return its id
    const id = generateId();
    await db.query("INSERT INTO cover_letter (id, organization_id, ...) VALUES ($1, $2, ...)", [id, orgId]);
    return id;
  },
  api: { list, get },             // optional; enables the API ID-fuzz check
}
```

3. Run `pnpm --filter @careeros/isolation-testing test:ci`.

## What runs

- **DB check** (`runDbIsolationCheck`): seeds one Org A row with the owner pool, then on the `careeros_app` pool verifies Org B sees 0 rows (all, and by id) and Org A sees exactly 1.
- **Coverage check** (`runCoverageCheck`): every table in the schema with an `organization_id` column must be in the registry, have RLS enabled **and forced** (`FORCE ROW LEVEL SECURITY`) and have a policy. A forgotten registry entry fails CI.
- **Allow-list** (`tenancyAllowList` in `src/registry.ts`): tables that have an `organization_id` column but define tenancy instead of holding tenant data (`organization`, `member`, `invitation`, from the Better Auth organization plugin). They skip the registry, RLS and policy requirements. Each entry needs a non-empty `reason`; a table that is both registered and allow-listed fails.
- **API check** (`runApiIsolationCheck`): Org B calling `get` with Org A's id must get 404 (not 403, not 200), and `list` must omit it.
- **Runner** (`registerIsolationSuite`): one Vitest `describe` per registry entry.

All reads under test use the `careeros_app` connection. The checks throw if it is a superuser or has BYPASSRLS. `self-test.test.ts` proves the checks catch leaks using a throwaway schema (dropped after every run, even on failure).

Needs `CAREEROS_TEST_DATABASE_URL` and `CAREEROS_TEST_APP_DATABASE_URL` (see `@careeros/testing`), `pnpm --filter @careeros/testing db:test-role`, and upstream migrations applied (`pnpm db:migrate`) for the `public` schema check.
