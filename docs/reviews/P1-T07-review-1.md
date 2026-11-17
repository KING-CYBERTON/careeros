# P1-T07 review 1 (Opus, 2026-11-01)

Branch: feature/P1-T07-career-rls (aa0b360ca, merge c263dacbf)
Verdict: approve, subject to fully green CI including e2e.

## Checked

- The diff against develop touches only T07 files. Taking `--ours` in the develop merge reverted nothing, because develop's tree equals the T06 tip.
- Migration 20261101083119_career_rls:
  - All 11 tables get NOT NULL `organization_id` with a cascade FK.
  - The backfill follows the parent chain (application, then schedule, then job), with the oldest-membership fallback.
  - FORCE RLS, with `tenant_isolation` and `owner_access`.
  - `down.sql` refuses to run across orgs and restores the T06 interim functions.
- `career_workspace` has a composite FK to `application(organization_id, id)` with ON UPDATE CASCADE. That is better than a trigger, because the database enforces it for every writer.
- Definer functions:
  - `careeros_due_career_jobs` returns only `(id, organization_id)`. The two org-list functions return only org ids.
  - The guest move keeps the anonymous-source and target-membership checks.
  - All have a pinned search_path and are granted only to `careeros_app`.
- The scheduler claims, leases and executes each job inside `withOrgContext(job.organization_id)`. A failure in one org or job does not stop the others. The interim T06 functions are dropped.

## Decisions on open questions

- **Q44:** the composite FK stays on the workspace only for now. The other application-linked tables are covered by scoped reads plus RLS. P1-Q03 (the cross-org ID fuzz) will probe them, and a follow-up will add composite FKs if it finds a gap.
- **Q45:** accepted. The upkeep org list is the right D9 shape. Two emails per org per tick is fine.
- **Q46:** accepted. Knowledge not tied to an application stays with the guest, which matches the behaviour before RLS.
- **Q47:** accepted for Phase 1, since at most 2 jobs run per tick, so at most 2 pooled clients are held. Follow-up: split each job into claim, then work outside the context, then write back, before scaling beyond the VPS (P2 backlog).
- **Q48:** accepted. T08 must check the org of every `ai_provider_id` it can reach, including `career_schedule.ai_provider_id`.
