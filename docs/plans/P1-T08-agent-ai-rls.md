# P1-T08: Agent and AI tables join the tenant boundary

**Status:** Approved (Opus, 2026-11-01). **Thread:** 1 Build. **Phase plan:** P1-PHASE-PLAN.md (D4, D9, D11).
**Depends on:** P1-T07. Stack on `feature/P1-T07-career-rls`, then merge develop once T07 lands.
**Branch:** `feature/P1-T08-agent-ai-rls`

## Scope

`ai_provider`, `agent_thread`, `agent_message`, `agent_attachment`, `agent_action` and `ai_content_report`.

## Requirements

1. **Columns and backfill.**
   - Add `organization_id text NOT NULL`, with an FK ON DELETE CASCADE, and make every index that leads with `user_id` org-led.
   - Child rows take their parent's org: message, attachment and action take the thread's.
   - A thread linked to a resume, cover letter or application takes that row's org.
   - Everything else takes the owner's oldest membership, with the same personal-org fallback as T05 to T07.
   - The migration is idempotent, and `down.sql` refuses to run where a user has rows in more than one org.
2. **Keys (D11).**
   - Saved AI providers are per (org, user). The partial unique "one default" index becomes `(organization_id, user_id) WHERE is_default`.
   - `agent_message (thread_id, sequence)` stays as it is.
3. **Cross-org references.** These must all point into the same org: `agent_thread.ai_provider_id`, `source_resume_id`, `working_resume_id`, `cover_letter_id` and `application_id`; `agent_action.resume_id`; and `career_schedule.ai_provider_id` (Q48 from T07; remove the `TODO(P1-T08)` markers).
   - Prefer composite FKs `(organization_id, x_id) → parent(organization_id, id)` wherever the parent already has (or can cheaply get) that unique key, because the database then enforces it for every writer. Otherwise use scoped reads.
   - A cross-org id answers NOT_FOUND.
   - Composite FKs use ON DELETE SET NULL on the id column only. Use `ON DELETE SET NULL (x_id)` (PG15+), so that `organization_id` is never nulled.
4. **ai_content_report.**
   - Tenant-scoped like the other tables: the report belongs to the reporter's active org at report time.
   - Account deletion must still remove a user's reports. The existing e2e `ai-reports.spec.ts` must stay green.
   - Any cross-user review or listing path that exists today (an admin queue) goes through a definer function that returns only what the reviewer needs. If no such path exists, document that the platform-admin queue arrives in Phase 3.
5. **Background paths.**
   - Find every job or stream that touches these tables outside a request: resumable replies, Redis cancellation, cleanup, and the assistant's tools calling other services.
   - Each must run inside `withOrgContext(row.organization_id)`, using the D9 definer-list pattern where it scans across orgs.
   - The assistant's tools must act only on the active org's documents. Add a test for it.
6. **Guest linking.** Extend the guest move, either with `careeros_move_guest_agent` or by folding it into an existing function. Use the same checks. Provider defaults must not conflict: the guest's default yields to the target's.
7. **Code and tests.**
   - Every insert and upsert sets `organizationId`. The tenant column stays out of outputs and the export, which covers the active org only.
   - Register all six tables in `packages/isolation-testing`.
   - Add `agent-tenancy.integration.test.ts` covering two-org separation, a default provider in each org, cross-org refusals (including the career schedule provider), the assistant's tools being scoped, and the guest move.
   - Add a migration test covering backfill, key change, rerun, the down refusal and down/up.
   - Upstream edits get `CAREEROS:` markers and rows in UPSTREAM_PATCHES. Questions start at Q49, unless T09 has landed first; T09 uses Q60 and up.

## Acceptance

- careeros-ci is fully green, e2e included.
- With no org context, `careeros_app` sees zero rows in any of the six tables.
- No `TODO(P1-T08)` markers remain.
