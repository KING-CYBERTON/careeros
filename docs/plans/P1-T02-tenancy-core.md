# P1-T02 — `@careeros/tenancy`: org context and request resolution

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 1 Build · **Phase plan:** [../P1-PHASE-PLAN.md](../P1-PHASE-PLAN.md) (D3, D5, D9) · **Depends on:** P1-T01, P1-C01

## Goal

One small package gives every request and background job an explicit organization context that PostgreSQL RLS can read, and fails closed when there is none.

## Package `packages/tenancy` (`@careeros/tenancy`, tags `runtime:server`, `role:infra`)

1. `withOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T>`
   - Validate `orgId` (non-empty string, max 64, `[A-Za-z0-9_-]`); throw `TenancyError("invalid_org")` otherwise.
   - Check out a client from the app pool (`getPool()` from `@reactive-resume/db/client`), run `select set_config('app.current_org_id', $1, false)`, then run `fn` inside upstream's request-scoped database store so the global `db` proxy and `getPool()` use **this client** for the whole call (add a minimal exported helper in `packages/db/src/client.ts`, e.g. `withDatabaseClient(client, fn)`, next to `withDatabasePool`, marked `// CAREEROS:`; it must make `db` run every query on that single client, including `db.transaction`).
   - `finally`: `select set_config('app.current_org_id', '', false)`; release the client. If `fn` or the reset throws, call `client.release(error)` so pg destroys it.
   - Nested call with the **same** org reuses the current client; nested call with a **different** org throws `TenancyError("org_switch_in_scope")`.
   - `currentOrgId(): string | undefined` reads the active scope.
2. `resolveOrgForRequest({ session, apiKey })`: returns `session.activeOrganizationId` after verifying a `member` row for `(org, session.userId)` exists; for API-key auth returns the key's `organization_id` (column added in this task to `apikey`, nullable, per D8) after the same membership check for the key's user. Never reads an org id from headers, query or body. Returns `undefined` if none.
3. Middleware:
   - oRPC: a middleware usable on `protectedProcedure` that resolves the org and wraps the handler in `withOrgContext`. If no org resolves → `ORPCError("FORBIDDEN", { message: "No active organization" })`. Wire it in `packages/api/src/context.ts` so every `protectedProcedure` gets it (`// CAREEROS:`), except an explicit allow-list of procedures that must work without an org (list them in the spec PR: e.g. auth/session helpers, org list/switch). Public procedures are unaffected.
   - Hono: same for the MCP route and any non-oRPC authenticated route group in `apps/server/src/{http,mcp}`; list each route touched.
4. Inventory: grep for `getPool(`, `new Pool(`, `pool.query`, `client.query` and raw `pg` usage outside `packages/db`; list every hit in the PR with one of: "goes through `db`/`getPool` → covered", "wrapped in this PR", or "global by design (reason)".

## Tests (in the package, real Postgres via `@careeros/testing`)

- Context visible inside `fn` (`current_setting`), empty after return, empty after throw.
- A failing `fn` destroys the client (pool `totalCount` drops / client not reused).
- 50 concurrent `withOrgContext` calls with alternating orgs each see only their own org.
- No context → `current_setting('app.current_org_id', true)` is empty/NULL.
- Nested same-org reuse, nested different-org throws.
- `resolveOrgForRequest`: non-member active org → `undefined`; header-supplied org ignored.

## Out of scope

RLS policies and `organization_id` columns on feature tables (P1-T04+), signup behaviour (P1-T03), host-based resolution (Phase 2).

## Acceptance

- CI green; boundaries clean; UPSTREAM_PATCHES rows for every upstream file (`packages/db/src/client.ts`, `packages/api/src/context.ts`, auth schema for `apikey`, server routes).
- Existing upstream tests still pass without modification, except where a test calls a `protectedProcedure` with a user that has no org: such tests get an org via a shared test helper, listed in the PR.
