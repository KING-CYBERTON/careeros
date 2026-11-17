# P1-T03 Signup org, invitations and org switching: Opus review 1

**Branch:** `feature/P1-T03-signup-invites` @ `039423c7b` · **Spec:** [plans/P1-T03-signup-invites.md](../plans/P1-T03-signup-invites.md) · **Verdict:** Approved after one small change (M1)

This is a solid implementation. The skip rule for invited sign-ups needs both the id and a matching pending invitation for that email, so neither alone is enough. The admin role-change gap in the plugin was found and closed on the server. The personal org, its owner member and the active-session update happen in one transaction. The route tree was regenerated with the official generator, not edited by hand.

## Findings

- **M1 (Medium, Q17):** `deleteAccount` refuses even when another owner remains. Allow deletion when every shared org the user owns still has at least one other `owner`. Refuse only when the user is the **last** owner of an org with other members. Add a test for each case.
- **Low:** the 250 ms settle delay in the auth integration test's `afterAll` is accepted, because it covers test teardown only. If it shows up again in CI, fix the root cause by terminating the backends before `DROP DATABASE` with `pg_terminate_backend` or `WITH (FORCE)`.

## Questions answered

- **Q14:** keep requiring a verified email before accepting. Someone can hold an invitation id without owning the mailbox, for example when the inviter shares the link. The accept page's "verify first" state is the right UX.
- **Q15:** no column in Phase 1. A new login gets the oldest membership, and the session remembers switches. Phase 2's host-based resolution makes this moot.
- **Q16:** the `user.delete.before` cleanup of sole-member orgs is confirmed.
- **Q17:** see M1.
- **Q18:** refusing `createApiKey` when the active org is stale is confirmed (fail closed).

## Notes for P1-T04

Users who signed up through an invitation and never accepted have no org. After T04 they reach only the allow-listed procedures and the "accept your invitation" notice. That is intended.

## Re-review (commit `861956d`)

**M1 fixed.** Deletion is now refused only when the user is the last owner of an org with other members. The tests cover both the allow and refuse cases. Q14 to Q18 are recorded. **Approved, merge after green careeros-ci.** The unit job may hit the unrelated cleanup deadlock that P1-Q04 fixes. If it does, check that the failure is in the lanes, career or documents cleanup `beforeEach` and not in T03 code.

## Review 2: CI e2e on `861956d` (7 failures)

T03 is the first change that gives every user an org, so request scopes are now real. That turns on the scope-outliving call sites listed in P1-T02 review C1.

### H1 (High): agent and career-coach work after the request ends fails with `scope_closed`

The assistant specs (3) and career-coach specs (3) fail. The server logs `[agent] Failed to persist step draft { name: 'TenancyError' }`. Here is why:

- The agent stream (`agent/service.ts`, `onStepFinish` and the final persistence) keeps running after the oRPC handler returns.
- Its callbacks were created inside the request's `withOrgContext`, so they inherit the scope, which is now closed.
- The guard correctly refuses to use the released client.

**Fix (Opus design, part of this PR because T03 is what activates it):**

1. In `@careeros/tenancy`, add `captureOrgScope(): <T>(fn: () => Promise<T>) => Promise<T>`.
   - When called inside an open scope, it records `currentOrgId()`. With no scope it records `undefined`.
   - The returned runner exits the current tenancy store and the db request store, using `AsyncLocalStorage.exit` or a new exported `withoutDatabaseScope` helper next to `withDatabaseClient`.
   - It then runs `fn` in a **fresh** `withOrgContext(orgId)`, or with no scope when nothing was recorded, which keeps `ORG_CONTEXT_REQUIRED = false` behaviour.
   - Each call checks out its own client briefly. Never hold a client for the whole stream.
2. Use it wherever work continues after the handler returns. Capture at handler start, and wrap each write.
   - `agent/service.ts`: step-draft persistence, final message persistence, run status updates, and the run-timeout and cancellation paths that write to the DB.
   - The career-coach paths that the career specs exercise. Trace them from the failing specs: "Thanks. I'll use your answer…" and "Story decision received.".
   - Any other write that the failing specs show. List every call site in UPSTREAM_PATCHES (the "can outlive a scope" section) and mark each as fixed.
3. Tests:
   - A tenancy unit or integration test: a runner captured in scope A and invoked after A closed sees org A in a fresh scope, and so does a second invocation. Each invocation checks out and releases its own client.
   - One with nothing captured runs unscoped.
   - An api-level test that drives the agent step-persist path after the handler returned, if feasible with the existing agent test doubles.

### M1 (Medium): concurrent queries on one scoped client

The server logged `Calling client.query() when the client is already executing a query`. Inside a scope, `Promise.all` over `db` calls now shares one client. pg queues them, so this is correct today, but pg 9 removes the queueing.

Don't change behaviour in this PR. Add a row to docs/questions.md (Q20) with the call sites you can identify from the log or a grep for `Promise.all` in protected handlers. Opus will plan the follow-up.

### M2 (Medium): `organization.spec.ts:73`, invalid invitation shows the wrong state

The `authPage` user is unverified, so the page probably renders "Verify your email first" before it checks the invitation. Check the invitation first. A missing, expired or foreign invitation shows "Invitation unavailable" whatever the verification state. Show the verify state only for a valid invitation addressed to this user. If Better Auth refuses to read the invitation for unverified users, handle that error as "unavailable" only when the invitation truly doesn't exist, and explain the choice. Then fix the spec if needed.

## Re-review 2 (commit `7e1f48b`)

- **H1 fixed.** `captureOrgScope` takes the org at handler start. Its runner leaves both stores and opens a fresh, short `withOrgContext` per call, or runs unscoped when nothing was captured. `withoutDatabaseScope` exits only client scopes, so test pools are kept. The agent's step and final writes, run cleanup and every tool `execute` are wrapped. The tests cover a closed scope, a timer, a still-open scope (a separate client) and nothing captured.
- **M1:** recorded as Q20.
- **M2 fixed.** The verify state appears only for the email-verification error code. Every other error shows "Invitation unavailable".

Approved, merge after green CI. If e2e still fails, trace each remaining write from the spec.
