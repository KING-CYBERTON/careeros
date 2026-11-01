# P1-T09: Remaining tables join the tenant boundary

**Status:** Approved (Opus, 2026-11-01). **Thread:** 1 Build. **Phase plan:** P1-PHASE-PLAN.md (D4, D9, D10, D11).
**Depends on:** T04 and T05 (merged). It is independent of T06 to T08: it branches from develop, and conflicts in shared docs and the registry are resolved at merge.
**Branch:** `feature/P1-T09-remaining-rls`

## Scope

- `custom_domain`, `storage_cleanup_job` and `web_access_credentials`.
- The coverage check: any `public` table outside the tenancy registry and the explicit global allowlist must fail CI. That allowlist is auth, organization, member, invitation, verification, the jwks/oauth tables, and everything T06 to T08 own. Add the check if P1-Q02 did not already add it, or confirm it exists. While T06 to T08 are unmerged, list their tables in a "pending" set with a TODO that names each ticket.

## Requirements

1. **custom_domain (D10, Q31).**
   - Add `organization_id` (NOT NULL, FK with cascade) and switch the primary key to `(organization_id, user_id)`, per D11. Keep the verified-hostname unique index global.
   - ENABLE and FORCE RLS, with `tenant_isolation` and `owner_access`.
   - Public lookups must not need an org context. Add definer functions that do a hostname-only lookup, using the pinned search_path and granted only to `careeros_app`:
     - `careeros_public_domain_owner(hostname)` returns `(user_id, organization_id)` for a verified domain.
     - The Traefik provider endpoint gets whatever it needs, for example `careeros_verified_domains()` returning hostnames only.
   - Rework `verifiedDomainColumn()` and `customDomainUsername()` to use them (Q31). The `careeros_public_indexable_resumes*` functions already run as the owner, so confirm they still read `custom_domain` correctly under FORCE RLS.
   - The DNS re-verification job is a background job, so it follows the D9 pattern: a definer function lists the org ids or `(user_id, organization_id)` pairs that are due, then the job works on each inside `withOrgContext`, and one failure does not stop the others.
2. **storage_cleanup_job.**
   - It deliberately has no user FK, so that erasure work outlives the account. Give it `organization_id text NOT NULL` with **no FK**, so that deleting an org does not cancel its erasure work. Explain this in a comment.
   - Backfill from the owner's oldest membership, falling back to the `bf_` personal org id rule. Rows whose owner no longer exists get the sentinel org `'careeros_orphan'`, documented in a comment, which is processed like any other org.
   - The unique key becomes `(organization_id, owner_id, storage_key)`.
   - RLS as above. The writers, which run in the same transaction as the document or account delete, set `organizationId` from the current context.
   - The worker claims through a definer function `careeros_due_storage_cleanup(now, limit)` returning `(id, organization_id)`, then claims, acknowledges and fences inside `withOrgContext`. Keep the claimToken fencing.
   - Account deletion: work created by the account delete must still be written and processed. Add a test for it.
3. **web_access_credentials.** Add `organization_id` (NOT NULL, FK with cascade), switch the key to `(organization_id, user_id)`, and apply RLS. The upsert conflicts on the new key.
4. **Guest linking.** If a guest can hold rows in these tables, extend the move with the same checks as before. Otherwise, document why not.
5. **Code, tests and docs.**
   - Every insert and upsert sets `organizationId`, and the tenant column stays out of outputs.
   - Register the tables in `packages/isolation-testing`.
   - Add `remaining-tenancy.integration.test.ts` covering two-org separation, a public domain lookup with no context, the cleanup worker across two orgs with failure isolation, and work outliving the account.
   - Add a migration test covering backfill, rerun, down/up and the down refusal.
   - Upstream edits get `CAREEROS:` markers and rows in UPSTREAM_PATCHES. Log open points in questions.md, using the next free number on develop when you push.

## Acceptance

- careeros-ci is fully green, e2e included.
- With no org context, `careeros_app` sees zero rows in these tables.
- Custom domains still resolve publicly.
