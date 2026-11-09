# P3-T08 review 1

**Reviewer:** Opus, 2026-11-08. **PR:** [#89](https://github.com/KING-CYBERTON/careeros/pull/89). **Verdict:** Approved. Merge on fully green CI, e2e included (the Playwright spec's first run is in CI).

## Checked

- Every `orgAdmin` procedure is a `protectedProcedure` and calls `requireOrgAdmin`, which reads the organization from the tenant context (never the input), the role from `member`, and refuses personal workspaces. Members get 403.
- `cohort` is a tenant table with RLS enabled and forced, `tenant_isolation`, an isolation registry entry, a fuzz inventory entry and a `down.sql`; the composite foreign keys use `ON DELETE SET NULL (cohort_id)`, no CASCADE.
- Bulk invites send each row through Better Auth `createInvitation`, so the P3-T02 seat hooks and the database trigger apply; the bulk path cannot exceed the seat limit. One audit row per send, with counts only.
- Analytics run as org-scoped SQL in the org context (RLS applies); no definer function. EXPLAIN on a 1,000-member org next to a 3,000-member neighbour: 4.64 ms.
- CSV exports escape cells starting with `=`, `+`, `-`, `@`, tab or carriage return, and write an audit row.

## Answers

- **Q320, Q321:** accepted.
- **Q322:** accepted for v1. Interviews and offers by stage history are a backlog item once the job timeline (P4) exists.
- **Q323:** accepted. The console is part of every paid plan.
- **Q324:** accepted for now (exports are bounded by org size). Streaming is a backlog item.
- **Q325:** accepted. Cross-org refusal for a real second org is covered by the integration tests.
- **Q326, Q327, Q328, Q329, Q330:** accepted.
- **Legal note (P6-T01 Q290):** org admins now see members' names, emails and activity counts, never resume or letter content. The privacy and DPA drafts must say so before approval.
