# P3-T02: Enforce seats, suspension and plan features on the server

**Status:** Approved (Opus, 2026-11-02). **Thread:** 1 Build. **Phase plan:** [P3-PHASE-PLAN.md](P3-PHASE-PLAN.md), decisions D3 and D4. **Depends on:** P3-T01 merged.
**Branch:** `feat/P3-T02-enforcement`. **Questions:** start at Q210.

## Goal

What an org's plan and status allow is decided on the server for every request, using `getEntitlements` from T01. The UI only reflects that.

## Requirements

1. **Seats:**
   - Creating an invitation is refused with `SEAT_LIMIT_REACHED` when `seatsUsed >= seatLimit`. Pending invitations count, as T01 defines.
   - Accepting an invitation, and an open-signup join on an org host (P2-T03), are refused the same way. This covers the race where several invitations were sent and seats then filled.
   - Use the Better Auth organization plugin's hooks (`beforeCreateInvitation`, `beforeAddMember`, or whichever the installed version provides; check `node_modules`, not memory) and the P2-T03 join path. Also block any other route that adds a member: grep for every insert into `member` and list them in the PR.
   - Removing a member or cancelling an invitation frees the seat immediately.
   - A null `seatLimit` means unlimited.
2. **Suspension (read-only):**
   - In `protectedProcedure` (`packages/api/src/context.ts`), after the org is resolved, refuse with `ORG_SUSPENDED` (HTTP 403) when `readOnly` is true and the procedure writes.
   - A procedure counts as a write when its OpenAPI route method is not GET. A procedure with no route method is treated as a write.
   - Add an explicit allow-list of writes a suspended org still needs: sign-out, data export, account deletion, the member's own profile and password, leaving the org, and the T06 billing procedures (an empty placeholder until T06). Keep the list in one const with a comment for each entry.
   - The MCP server and API keys get the same rule.
   - Better Auth's own endpoints are not oRPC. Block the organization plugin's invite, add-member and role-change endpoints for suspended orgs in the same hook as item 1.
   - Web: a suspended org shows a full-width banner on every dashboard page ("This organization is suspended. You can view and export your data. Contact your administrator."), and disables write actions where the existing UI has a single place to do so. The server is the guard, so don't chase every button. Mobile: the same banner text on the home screen.
3. **Plan features:**
   - Add `requireFeature(key)` middleware for oRPC procedures, which refuses with `FEATURE_NOT_IN_PLAN` (403, carrying the key). Apply it now to the existing org custom-domain procedures (`custom_domain`). Other keys are applied by the tasks that build those features.
   - `branding` stays available on every plan except `personal`; check PRODUCT.md §11 and list the mapping in the PR.
   - The resolved flags reach the SPA. Extend the router context `flags` in `apps/web/src/router.tsx` with the org's resolved feature map from `organization/entitlements`, refetched on org switch. Gate the Domains settings page on `custom_domain`, with a short "Available on Pro" note instead of the form.
4. **Personal orgs:**
   - The `personal` plan has 1 seat, so a personal workspace cannot invite. The members page explains this and points to creating an organization (Phase 3 backlog: a create-org screen is not in this task).
   - Make sure nothing else breaks for personal orgs: resumes, letters, tracker and AI on own keys all keep working.
5. **Errors:** `SEAT_LIMIT_REACHED`, `ORG_SUSPENDED` and `FEATURE_NOT_IN_PLAN` get readable messages through the existing `getReadableErrorMessage` path, on web and mobile, with Lingui strings.
6. **Tests:**
   - Integration tests on an isolated database:
     - Invite at the limit is refused, and the accept race is refused.
     - A suspended org cannot write through oRPC, an API key or the Better Auth org endpoints, but can do each allow-listed action.
     - A feature-gated procedure is refused without the feature and allowed with it, including through an org-level flag override.
   - An e2e spec: an org on `starter` with its seat limit set low in the test fixture invites up to the limit and is refused after it. A suspended org shows the banner and gets a refusal on save.
   - Add a test that lists every non-GET oRPC procedure and fails if one is missing from both the write rule and the allow-list, so new procedures are covered by default.
7. Mark upstream edits `CAREEROS:` and list them. Add a CHANGELOG line. Log open points as questions and stop that part.

## Acceptance

- careeros-ci is fully green, and the isolation, inventory and skipped-suite guards pass.
- No path adds a member past the seat limit, and no write succeeds for a suspended org outside the allow-list. Show both in tests.
