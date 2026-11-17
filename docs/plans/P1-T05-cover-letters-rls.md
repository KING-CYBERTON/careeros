# P1-T05 Cover letters: row-level security

**Thread:** 1 — Build · **Status:** Approved (Opus, 2026-11-01) · **Branch:** `feature/P1-T05-cover-letters-rls` · **Includes:** P1-Q02 for this batch

## Goal

Put `cover_letter` and `cover_letter_version` behind the same tenant boundary that P1-T04 gave the resume tables. Follow the T04 pattern exactly. Read `docs/plans/P1-T04-resumes-rls.md` and `docs/reviews/P1-T04-review-1.md` first.

## Scope

1. **Migration** (`pnpm db:generate`, then hand-edit, idempotent, with a `down.sql`):
   - Add `organization_id text` to both tables. Backfill `cover_letter` from the owner's oldest membership, the same rule as the T04 resume backfill. Backfill `cover_letter_version` from its cover letter.
   - Then set NOT NULL, add an FK to `organization(id)` with `ON DELETE CASCADE`, and add org-led indexes that mirror the existing user-led ones.
   - `ENABLE` and `FORCE ROW LEVEL SECURITY`, add the `tenant_isolation` policy (USING and WITH CHECK on `organization_id = current_setting('app.current_org_id', true)`) and the `owner_access` policy `TO CURRENT_USER`, both exactly as in T04.
2. **Drizzle schema:** add `organizationId` to both tables in `packages/db/src/schema/cover-letter.ts` with a `CAREEROS:` marker.
3. **Writes:** every insert sets `organizationId: requireOrgId()`. That covers `service.ts`, `versions.ts`, `draft.ts` and any importer or agent tool that creates cover letters (search for `coverLetter` inserts across `packages/`).
4. **Cross-table references:**
   - Before setting `sourceResumeId`, read the resume through the normal scoped query, so RLS proves it is in the same org. Return NOT_FOUND otherwise.
   - `sourceApplicationId` stays as it is until T06, which adds the same check. Leave a `CAREEROS:` TODO naming T06.
5. **Long-running paths:** `cover-letters/draft.ts` already captures the scope (T04). Check that every write in it, including the final save, runs through the captured runner.
6. **No public surface:** cover letters have no public route, so no definer function is needed. If you find one, stop and log a question.
7. **P1-Q02:**
   - Register both tables in `packages/isolation-testing` with API checks.
   - Add `cover-letter-tenancy.integration.test.ts` against the real `careeros_app` NOBYPASSRLS pool. It must show:
     - User B gets NOT_FOUND on every cover-letter procedure for A's ids (list, get, update, delete, versions, draft, export).
     - Cross-org and no-context inserts are refused, and a no-context read returns nothing.
     - A `sourceResumeId` from another org is refused.
   - Extend the migration integration test to seed cover letters and check the backfill, rerun and down/up.
8. **Docs:** add `UPSTREAM_PATCHES.md` rows under P1-T05, and log open points in `docs/questions.md`.

## Out of scope

The application tables (T06) and other batches. Do not change the tenancy core.

## Acceptance

- All checks in item 7 pass. The affected package suites pass with the CI env.
- Lint and format checks are clean. A tsdown build starts and `/api/health` is healthy.
- careeros-ci is green, including e2e.
