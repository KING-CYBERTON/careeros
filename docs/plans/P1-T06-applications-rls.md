# P1-T06 Applications: row-level security

**Thread:** 1 — Build · **Status:** Approved (Opus, 2026-11-01) · **Branch:** `feature/P1-T06-applications-rls` · **Includes:** P1-Q02 for this batch

## Goal

Put `application`, `application_lane`, `application_pipeline` and `application_profile` behind the tenant boundary. Follow the T04 and T05 patterns and helpers. Read `docs/reviews/P1-T04-review-1.md` and `docs/reviews/P1-T05-review-1.md` first.

## Decisions (Opus)

- **D11. Per-user singletons become per-(org, user).** `application_pipeline` and `application_profile` are keyed by `user_id` alone today. A user who belongs to two orgs gets a separate pipeline and a separate application profile in each, so no org can see another org's job-search data.
  - Change each primary key to `(organization_id, user_id)`.
  - Existing rows go to the owner's oldest membership, the same rule as T04 and T05.
  - Code that lazily creates these rows creates them in the current org.
- Lanes and applications belong to the org of the pipeline they sit in.

## Scope

1. **Migration** (generated, then hand-edited, idempotent, with a `down.sql`):
   - Add `organization_id` to all four tables, backfill (lanes and applications from their owner's oldest membership, consistent with the pipeline), set NOT NULL, add an FK with cascade and org-led indexes.
   - Change the primary keys as D11 says. Update any unique indexes that are user-scoped today, for example lane names per user, so they are scoped to (org, user).
   - ENABLE and FORCE RLS on all four tables, with `tenant_isolation` and `owner_access` as in T04.
   - The down migration restores the old keys. It may fail if a user has rows in two orgs; document that in `down.sql`.
2. **Drizzle schema:** add the columns and keys with `CAREEROS:` markers. Update the relations.
3. **Writes:** every insert or upsert sets `organizationId: requireOrgId()`. Upserts keyed on `user_id` must now conflict on `(organization_id, user_id)`. Search all of `packages/` for writers: the applications service, lanes, application-profile, agent tools, MCP tools and importers.
4. **Cross-table references:**
   - Resolve the T05 TODO: before setting `cover_letter.source_application_id`, read the application through the scoped query and return NOT_FOUND across orgs.
   - Before setting `resume.application_id` or `application.resume_id`, read the target through the scoped query in the same way.
5. **Guest linking:** if `linkAnonymousAccount` moves applications, lanes, pipeline or profile rows, extend it with a narrow definer function, as T04 and T05 did, and test it.
6. **Background paths:** find any scheduler, cron or long-running job that touches these tables (reminders, ghosted detection, lanes revision). Make it use the per-org definer-list pattern from T05 H1, or the captured scope. Log what you find.
7. **P1-Q02:**
   - Register all four tables in `packages/isolation-testing` with API checks.
   - Add `application-tenancy.integration.test.ts` against the real `careeros_app` pool. It must show:
     - User B gets NOT_FOUND on every application, lane, pipeline and profile procedure for A's ids.
     - Cross-org and no-context inserts are refused.
     - A user in two orgs sees a separate pipeline and profile in each, and switching the active org switches them.
     - Cross-org `resume_id`, `source_application_id` and `application_id` links are refused.
   - Add a migration test for the backfill, the key change, a rerun and down/up.
8. **Docs:** add `UPSTREAM_PATCHES.md` rows and log questions in `docs/questions.md`.

## Acceptance

- All tests pass with the CI env. Lint and format checks are clean.
- A tsdown build runs as `careeros_app` and `/api/health` is healthy.
- careeros-ci is green, including e2e. The lanes and application e2e specs are the main signal.
