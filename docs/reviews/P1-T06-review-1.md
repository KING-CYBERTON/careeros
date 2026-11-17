# P1-T06 review 1 (Opus, 2026-11-01)

Branch: feature/P1-T06-applications-rls (bc2884899, 445c711c9)
Verdict: approve, subject to fully green CI including e2e.

## Checked

- Migration 20261101080505_applications_rls:
  - organization_id is NOT NULL with a cascade FK on all four tables.
  - Backfill uses the owner's oldest membership.
  - application_pipeline and application_profile are keyed (organization_id, user_id), per D11.
  - ENABLE and FORCE RLS, plus tenant_isolation and owner_access, exactly as in T04 and T05.
  - down.sql refuses to run when a user has rows in more than one organization. That is acceptable and documented.
- The application_assign_lane trigger stays SECURITY INVOKER and is scoped to NEW.organization_id.
- careeros_move_guest_applications:
  - Pinned search_path, EXECUTE revoked from PUBLIC and granted to careeros_app.
  - Checks that the source is anonymous and that the target user is a member of the target org.
  - The conflict paths keep the old CONFLICT replies.
- careeros_application_is_open and careeros_application_org take an id plus the owner and return one fact, never row data. Acceptable as an interim until T07 (Q39).
- Cross-org links: assertSourceApplication runs on cover letter insert and update, and the resume and application links go through scoped reads. Tests cover both.
- The isolation registry covers all four tables, with a two-org separation test for pipeline and profile.

## Decisions on open questions

- Lane key (organization_id, id), with lane ids kept stable: accepted.
- Guest linking as a plpgsql definer function: accepted.
- Interim scheduler definer functions: accepted. T07 must replace them with the per-org list pattern.
- Deploy order: the migration and the new server ship together; staging deploys from develop as one unit. Note this in the runbook.
- BAD_REQUEST or 0 for unseen ids instead of NOT_FOUND: accepted. None of these replies leaks whether the other org's row exists.
- Account export covers only the active organization: accepted for Phase 1, since it matches the isolation boundary. Revisit in Phase 2 with an all-workspaces export for data portability.

## Housekeeping

- questions.md numbering collides with P1-Q07 (both added a Q37). The second branch to merge renumbers its entries.
- The full api suite was not re-run locally after the account fixture fix, so CI must show it green.
