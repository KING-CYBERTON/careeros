# P3-T08: Org Admin console: cohorts, bulk CSV invites, analytics, CSV export and quota view

**Status:** Approved (Opus, 2026-11-02). **Thread:** 1 Build. **Phase plan:** [P3-PHASE-PLAN.md](P3-PHASE-PLAN.md), decisions D3, D7, D8 and D10. **Depends on:** P3-T01 and P3-T02 merged. The quota view needs P3-T03; if T03 has not merged, ship the rest and log a question.
**Branch:** `feat/P3-T08-org-admin-console`. **Questions:** start at Q320.

## Goal

Org owners and admins run their own organization: group members into cohorts, invite many people at once, see how their members are doing, export that as CSV, and see AI usage against the quota. Everything is scoped to the admin's own org by the existing tenant rules.

## Requirements

1. **Who.** Org `owner` and `admin` roles only (Better Auth organization roles). Members get 403. A personal workspace (the signup org) has no admin console. Every procedure is a `protectedProcedure` in the current org, and checks the role on the server.
2. **Cohorts.**
   - A `cohort` tenant table (§6.2): `id`, `organization_id`, `name` (unique per org, at most 100 characters), `description`, `starts_on`, `ends_on` (nullable dates), `archived_at`, `created_at`, `updated_at`. ENABLE and FORCE RLS with `tenant_isolation`, registered in the isolation registry, a `down.sql`.
   - Add the composite tenant foreign key from `member.cohort_id` to `cohort` (`ON DELETE SET NULL (cohort_id)`), now that the table exists (see the comment in `packages/db/src/schema/organization.ts`).
   - API: `orgAdmin.cohorts.list/create/update/archive`, and `orgAdmin.members.setCohort(memberIds[], cohortId | null)` (at most 500 ids per call).
3. **Bulk CSV invites.**
   - Upload a CSV with `email` (required), `role` (`member` or `admin`; default `member`; never `owner`) and `cohort` (a cohort name; optional). At most 500 rows and 256 KB per upload. Parse on the server with a strict parser: UTF-8, a header row, no formulas evaluated, values trimmed, emails validated.
   - A dry run first returns per-row results (ok, duplicate in file, already a member, already invited, invalid email, unknown cohort, over the seat limit) without sending anything. Then a confirm call sends the invitations for the rows that were ok.
   - Seat limits come from `getEntitlements` and are checked per row through the same server path P3-T02 uses for single invitations, so the bulk path can never exceed the limit. Rows past the limit are reported, not sent.
   - Invitations use the existing invitation email and branding. Rate limit the confirm call per org.
   - Each bulk send writes one `audit_log` row with counts, never the email list.
4. **Analytics.**
   - Counts for a date range (default the last 30 days, at most 366 days) and an optional cohort: active members (signed in within the range), resumes created, applications created, applications by stage, interviews and offers (from the tracker's stages), AI credits used.
   - Computed by org-scoped SQL in the org context (RLS applies). No cross-org query, no definer function. Add an index if a query needs one, and show the plan in the PR for the largest query on a seeded org with 1,000 members.
   - A table of members with: name, email, cohort, last active, resumes, applications, interviews, offers. Sortable, paginated (50 per page).
5. **CSV export** of the analytics members table and of the summary, for the same filters. Generate on the server, stream it, and escape cells that begin with `=`, `+`, `-`, `@`, tab or carriage return (CSV injection). Each export writes an `audit_log` row (who, filters, row count).
6. **Quota view.** Pooled credits for the current period, used and remaining, the 80% and 100% thresholds, and usage by feature and by member (top 20), from `ai_usage` through T03's read functions.
7. **Audit view.** Org owners and admins see their own org's `audit_log` entries (D7), newest first, paginated, filtered by action. Read through the path T01 provides for org-scoped reads.
8. **UI (web).** A new "Organization" admin area in the dashboard: Members (with cohort column and bulk invite), Cohorts, Analytics (with export), AI usage, Audit log. Use the existing settings layout and `packages/ui` components. Lingui strings. Hide the area from members, but the server checks are what count.
9. **Mobile (D10).** The admin console is web-only, per the phase plan. Add the accepted exception to `.agents/docs/mobile-release-handoff.md` (or the parity note location agreed in P5-T01 Q238) with a link to D10. Members on mobile see their own cohort name in their profile, for parity of what members can see.
10. **Tests.**
    - Integration on an isolated database: RLS on `cohort`; a member gets 403 on every `orgAdmin` procedure; org A's admin cannot see or change org B's cohorts, members, analytics or audit rows (add the new ids to the cross-org fuzz inventory); bulk invites never exceed the seat limit, including two confirm calls at once; CSV injection cells are escaped; the export writes an audit row.
    - Unit: the CSV parser (bad encodings, extra columns, quoted commas, 501 rows), the row-result rules.
    - E2e: an admin bulk-invites three people with one over the seat limit, sees the dry-run results, confirms, and sees two invitations.
11. Mark upstream edits `CAREEROS:` and list them. Add a CHANGELOG line. Log open points as questions and stop that part.

## Acceptance

- careeros-ci is fully green, and the isolation, inventory and skipped-suite guards pass.
- No path lets an org admin read or write another org's data, or invite past the seat limit. Show both in tests.
