# P1-T02 Tenancy core: Opus review 1

**Branch:** `feature/P1-T02-tenancy-core` @ `2e2053557` · **Spec:** [plans/P1-T02-tenancy-core.md](../plans/P1-T02-tenancy-core.md) · **Verdict:** Changes requested (1 Critical, 1 High, 2 Medium)

The core is well built. `withOrgContext` validates the id, refuses an org switch inside a scope, destroys the client on any error, and resets the setting before a clean release. `withDatabaseClient` is a small, well-placed hook next to upstream's `withDatabasePool`. The inventory is complete and its reasoning holds.

## Findings

### C1 (Critical): continuations that outlive the scope keep the released client

AsyncLocalStorage carries the store into anything created inside the scope: `setTimeout`, un-awaited promises and generators the caller resumes later. After `withOrgContext` returns, the client goes back to the pool and the next request may check it out under **another org**. Any continuation that started inside the first scope still finds that client through `getPool()` and `db`, so it would query under the other org's setting. That is a cross-tenant leak once RLS lands.

This happens in today's code. Every one of these runs inside a protected procedure:

- `custom-domain/service.ts:241` (`void recheckStaleDomains()`)
- `public-pdf.ts:111` (a shared render promise)
- `agent/service.ts` and `cancellation.ts` (timers and long-running runs)
- `event-router.ts:34` (an `async function*` handler)
- `cover-letters/draft.ts` (an `async function*`)

**Fix:**

1. Give the scope a mutable `closed` flag. Set it in `finally` **before** `release`.
2. In `packages/db/src/client.ts`, `getPool()` and the `db` proxy must throw (`TenancyError("scope_closed")` or a plain `Error` with that code) when they see a closed client scope. They must never fall back silently to the global pool.
3. Test 1: a `setTimeout` scheduled inside a scope that queries after the scope has ended must throw `scope_closed`. Run another org's scope in between, and check that the setting that scope sees is unaffected.
4. Test 2: an async generator created inside a scope and iterated after the scope ends must throw the same way.
5. Inventory the five call sites above. Add a row to the T02 section of `docs/UPSTREAM_PATCHES.md` or the inventory table saying how each behaves now: fails loudly, which is acceptable until its table batch, or is awaited inside the scope.

Do **not** refactor those features in this task. Streaming and agent runs get their own scope handling in T07 and T08.

### H1 (High): merging T02 alone locks every user out (Q8)

Until D6 (an org at signup) and D7 (a backfill org for existing users) land, no user has an org. `protectedProcedure` would return FORBIDDEN for the whole app, and the e2e job would fail. T02 must not depend on T03.

**Fix (Opus decision, Q8):** export `ORG_CONTEXT_REQUIRED = false` from `@careeros/tenancy` (a code constant, not an env var).

- If an org resolves, the middleware runs the handler in `withOrgContext`, exactly as now.
- If none resolves and the constant is `false`, the handler runs without a scope.
- If it is `true`, the middleware throws FORBIDDEN as now.
- Apply the same rule in the MCP handler.
- Test both values of the constant. The existing FORBIDDEN tests should flip it with `vi.mock` or a setter used only by tests.
- Add a `// CAREEROS:` comment saying that **P1-T04 sets it to `true` in the same PR that adds the first RLS policy and the D7 backfill**. This is safe because no table has RLS before T04, and RLS fails closed without a context anyway.

### M1 (Medium): `getPool()` returns a `PoolClient` cast as `Pool`

Code that calls `getPool().connect()` inside a scope gets a `Client.connect()` error ("already connected") instead of a clear one. `listenOnPostgres` does this. **Fix:** inside a client scope, return a thin wrapper whose `connect()` throws `TenancyError("connect_in_scope")` with a message pointing to `withOrgContext`. Alternatively, document this in the JSDoc and add a test that it fails clearly. Either is acceptable.

### M2 (Medium): run e2e before handing back

H1 should make e2e pass. Run at least `tests/e2e/specs/auth.spec.ts` and one resume spec locally against the built server, following the CI recipe in `.github/workflows/careeros-ci.yml`. If the build cannot run in the sandbox, say so. CI will be the gate.

## Questions answered

- **Q8:** see H1. T02 merges on its own, with enforcement off until T04.
- **Q9:** fail closed is correct. P1-T03 adds the writer: `createApiKey` sets `organization_id` from the session's active org. Bearer and OAuth tokens get an org in Phase 2. With H1, these calls work without a scope until T04.
- **Q10:** the six-procedure allow-list is confirmed. `exportData` stays org-scoped.
- **Q11:** (a) `apikey` on `tenancyAllowList` is confirmed (D8). (b) No FK on `apikey.organization_id` is accepted. Validate the org id at write time in T03. (c) The `listenOnPostgres` risk is covered by M1 and C1.

## Accepted deviations

`resolveOrgForAuthentication` living in `@careeros/tenancy` is accepted. The shared `vitest.org.setup.ts` with `extraSetupFiles` is accepted.

## Re-review (commit `6689134fe`)

**Verdict: Approved. Merge after green careeros-ci.**

- **C1 fixed.** The scope is closed before the reset and release. `db`, `getPool()` and a nested `withOrgContext` throw `scope_closed` from a closed scope, and none of them falls back to the global pool. The tests cover a timer, a generator resumed from a timer, and a generator resumed by the caller, which runs in the caller's context.
- **H1 fixed.** `ORG_CONTEXT_REQUIRED = false` is tested in both states for oRPC and MCP. The comment that hands the flip to T04 is in place.
- **M1 fixed.** `connect()` inside a scope now throws `connect_in_scope`.
- **M2:** e2e could not run in the sandbox (no turbo, no browser download). CI is the gate.
- Note for T04: flipping `ORG_CONTEXT_REQUIRED` must update the shared test helpers. They already mock it as `true`.

## Re-review 2 (commit `464cf6313`)

**H2 (High, found by CI e2e): fixed.** `apps/server/tsdown.config.ts` only bundled `@reactive-resume/*`, so the built server loaded `@careeros/tenancy` from TypeScript source and crashed on startup. `shouldBundle` now also matches `@careeros/`. The Vercel and Cloudflare builds use the same config. Verified locally: a clean tsdown build, the server starts, and `/api/health` returns 200. Still approved, merge after green CI.
