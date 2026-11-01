# P1-T04 Resumes RLS: Opus review 1

**Branch:** `feature/P1-T04-resumes-rls` @ `97ec3db7b` · **Spec:** [plans/P1-T04-resumes-rls.md](../plans/P1-T04-resumes-rls.md) · **Verdict:** Changes requested (1 High, 1 Medium, 1 Low)

This is strong work. The migration is idempotent and reversible. Every definer function pins its `search_path`, applies the same public rule as `findResume`, and is executable only by `careeros_app`. The 18-test isolation suite runs against the real NOBYPASSRLS role. The scope-outliving call sites are fixed, not just listed.

## Findings

### H1 (High): running the app as the table owner silently turns isolation off

`owner_access` (`TO CURRENT_USER`) lets the migration role read every organization. That is correct for the definer functions. But a deployment whose runtime `DATABASE_URL` uses the same role as migrations (the upstream single-role setup, or a mistake in `.env`) gets no tenant isolation at all, and nothing warns.

**Fix:** a startup check in `apps/server/src/startup` that runs after migrations and before serving.

1. Query `current_user`. Check whether it owns `public.resume` (`pg_tables.tableowner`), and whether it has `rolsuper` or `rolbypassrls`.
2. If any is true and `NODE_ENV === "production"`, log a clear error naming the role and exit non-zero. Outside production, log a warning and continue, because the unit job runs as `postgres`.
3. Add unit tests for both branches.
4. The CI e2e job already runs production mode as `careeros_app`, so it exercises the pass path.
5. Document the check in `docs/self-hosting` or the staging runbook, whichever already describes the role split.

### M1 (Medium): Q30, keep MCP and API keys working

Fail-closed is right in principle, but losing all resume access for OAuth MCP clients and existing API keys is a visible regression in a release that only meant to add isolation.

**Fix:**

1. In `resolveOrgForAuthentication`, when a bearer or OAuth token or an API key has no organization, fall back to the user's oldest membership. Use the same ordering as the sign-in hook, check membership as today, and fail closed if the user has none.
2. In the migration, backfill `apikey.organization_id` for keys without one from the owner's oldest membership.
3. Add tests for the fallback: no membership is refused, and a bearer token from user A never resolves to an org of user B.
4. Add a `// CAREEROS:` comment saying Phase 2 replaces the fallback with org-bound tokens.

Pre-deploy signed PDF links failing for 10 minutes is accepted.

### L1 (Low): backfill org name fallback

A user with neither a name nor a username gets `My's workspace`. Use `Personal workspace` when both are empty.

## Questions answered

- **Q26:** `owner_access` is accepted, with H1 as its guard.
- **Q27:** the extra definer functions and the owner fallback through their own session org are accepted. `careeros_resume_count()` exposing one global number is accepted, since it was already public.
- **Q28:** `careeros_move_guest_resumes` is accepted for Phase 1. Its anonymous-source and target-membership checks are the right narrowing.
- **Q29:** the backfill rules are accepted.
- **Q30:** see M1.
- **Q31:** noted for the T09 spec.

## Re-review (commit `ac8f3f559`)

**Verdict: Approved. Merge after green careeros-ci.**

- **H1 fixed.** `startup/role-check.ts` refuses to start in production when the runtime role owns `resume`, is a superuser or has BYPASSRLS, and warns elsewhere. Both branches are tested, and the check is documented in `infra/staging/README.md`. The CI e2e job, which runs production mode as `careeros_app`, covers the pass path.
- **M1 fixed.** API keys without an org and OAuth bearer tokens fall back to the owner's oldest membership, and fail closed when there is none. A key that has an org whose owner isn't a member gets no fallback, and sessions never fall back. The apikey backfill is in the migration and its test.
- **L1 fixed.**
- Note for Phase 2: replace both fallbacks with org-bound tokens and keys (the `CAREEROS:` comments mark them).
