# P1-T03: Signup org, invitations and org switching

**Status:** Approved (Opus, 2026-10-31), but dispatch waits until Stephen confirms D6 · **Thread:** 1 Build · **Phase plan:** [P1-PHASE-PLAN.md](P1-PHASE-PLAN.md) (D1, D2, D5, D6) · **Depends on:** P1-T01, P1-T02 (both merged)

## Goal

Every user always has at least one organization and an active organization on every session. Owners and admins can invite people, and invitees can accept. This must be true before P1-T04 turns on RLS and `ORG_CONTEXT_REQUIRED`.

## Server (`packages/auth`, `packages/api`)

1. **Personal org at signup (D6).**
   - In `databaseHooks.user.create.after`, create an organization `{ name: "<displayName or username>'s workspace", slug: "u-<userId tail>" }` and an `owner` member row. This covers guest users too.
   - Skip this when the sign-up comes from an invitation. Detect that by a pending invitation for the user's email, plus an `invitationId` passed through the existing sign-up flow. The user becomes a member when they accept.
   - Put the logic in a CareerOS file, `packages/auth/src/personal-org.ts`. The upstream config gets one `// CAREEROS:` call.
2. **Active org on every session.**
   - In `databaseHooks.session.create.before`, if `activeOrganizationId` is empty, set it to the user's oldest membership.
   - A user with no membership gets none. They then hit `protectedProcedureWithoutOrg` procedures only, and the web shows an "accept your invitation" empty state.
3. **API keys carry the org (Q9).**
   - `createApiKey` stores `organization_id` from the caller's active org, after checking membership.
   - Keys created without an active org store null. They are refused once `ORG_CONTEXT_REQUIRED` is true.
4. **Account deletion.**
   - `deleteAccount` deletes the organizations where the user is the **only** member.
   - If the user owns an org that has other members, it refuses with a clear error ("transfer ownership first"). Ownership transfer UI is Phase 3.
5. **Org procedures.** Use the Better Auth organization plugin endpoints through the existing auth client: list orgs, set active, invite, accept, reject, cancel, list members, update role, remove member. Do not wrap them in oRPC. The server enforces the role rules: owner and admin can invite and remove, only the owner changes roles, and nobody removes the last owner.

## Web (`apps/web`)

6. **Accept-invitation page** at `/auth/accept-invitation/$invitationId`. The invitation email already links here.
   - Signed out: sign in or register, then come back.
   - Signed in: show the org name and inviter, with Accept and Decline. Accept sets the active org and goes to the dashboard.
   - Expired or invalid: an error state.
7. **Org switcher** in the dashboard sidebar or header. Show it only when the user has two or more orgs. Switching calls set-active, then invalidates the TanStack Query cache.
8. **Members & invites** at `dashboard/settings/members`, visible to owner and admin.
   - List members with their role.
   - Invite by email with role admin or member.
   - List pending invitations, with cancel.
   - Remove a member, and change role (owner only).
   - Use the existing settings layout and `packages/ui` components.
   - Every string uses Lingui. Run `pnpm lingui:extract`.

**Mobile:** no new UI in Phase 1. Mobile is out of CI per the upstream inventory (F11). It keeps working because signup creates the personal org on the server. Record the parity gap in `docs/UPSTREAM_PATCHES.md` under a "Mobile parity gaps" heading.

## Tests

- **Integration (auth):**
  - Self-signup creates exactly one org and an owner membership, and the session has that org active.
  - A guest gets one too.
  - An invited sign-up creates no personal org. After accepting, the user is a member and that org is active.
  - A second login keeps the active org.
  - `createApiKey` stores the org.
  - `deleteAccount` removes a sole-member org and refuses for a shared org the user owns.
  - Role rules: a member cannot invite, an admin cannot change roles, and nobody can remove the last owner.
- **e2e:** add `tests/e2e/specs/organization.spec.ts`. User A invites user B by email (read the link from the dev email log, or use the invitations API in the fixture). B accepts, B sees A's org in the switcher, and A removes B.
- **Existing tests:** all existing suites stay green.

## Acceptance

- Everything in Tests passes in CI.
- Every upstream edit is marked `CAREEROS:` and listed in `docs/UPSTREAM_PATCHES.md`.
- No change to `ORG_CONTEXT_REQUIRED`. P1-T04 owns that.
