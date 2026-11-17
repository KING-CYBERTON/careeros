# P1-T08 review 1 (Opus, 2026-11-01)

Branch: feature/P1-T08-agent-ai-rls (36ea22f54 and the develop merges through 54ce5ce24)
Verdict: approve, subject to fully green CI including e2e.

## Checked

- The diff against develop is limited to T08 scope. The schema, auth, career and cover-letter changes are the composite-FK unique keys, the `career_schedule.ai_provider_id` link (Q48), and fixture updates.
- Migration `agent_ai_rls`:
  - It sorts after T09, and the snapshot is chained after T09's.
  - The backfill follows the parent chain.
  - The managed provider id is renamed together with every reference to it (threads and career schedules), before the composite FKs are added.
  - Forced RLS, with `tenant_isolation` and `owner_access`.
  - `down.sql` refuses to run across orgs.
- Composite FKs: 12 of them, using `ON DELETE SET NULL (x_id)` so that `organization_id` is never nulled, and deferrable.
  - The database now enforces same-org links for every writer, which closes Q48 and covers the T07 Q44 concern for these tables.
- Definer functions:
  - `careeros_move_guest_agent` checks that the source is anonymous and that the target is a member of the target org.
  - `careeros_orgs_with_active_agent_runs` returns org ids only.
  - Both use the pinned search_path, have EXECUTE revoked from PUBLIC and are granted to `careeros_app`.
- The boot reaper runs per org with failure isolation. Runs and tools resolve documents through the org scope. No `TODO(P1-T08)` markers remain, and `pendingTenantTables` is empty.

## Decisions on open questions

- **Q66:** cross-org links nulled during backfill. Accepted: such links could only exist for multi-org users and are invalid by definition. Add a line to the migration header saying this.
- **Q67:** managed id `server-ai:<org>:<user>`. Accepted.
- **Q68:** deferrable composite FKs. Accepted.
- **Q69:** guest-move rules. Accepted. The target's default provider wins.
- **Q70:** `ai_content_report` is tenant-scoped, and the admin queue comes in Phase 3. Accepted, and noted for the Phase 3 plan.
- **Q71:** background paths. Accepted.
- **Q72:** attachment quota is per org. Accepted, and noted for the Phase 2 billing and limits spec.

## Phase 1a

With T08, every tenant table is under RLS. P1-Q03 (the cross-org ID fuzz) is the remaining Phase 1a gate.
