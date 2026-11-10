# P2-T03a review 1 (PR #107)

**Reviewer:** Opus · 2026-11-10 · Verdict: **fix needed (test only)**

The `org-host.ts` change matches the spec, and the unit tests cover the listed cases. CI e2e ran the new host-isolation case.
Every product step passed: "Join <org>" showed with no redirect, Accept landed on `/dashboard` on A's host, and the
`member` row has role `admin`. Only the last check failed.

## Findings

- **High · tests/e2e/specs/careeros-host-isolation.spec.ts:462-464 · The owner's member list never showed the invitee
  (30s timeout).** The fixture signs the owner up on the platform host first, so their oldest membership is their personal
  organization, and `withDefaultActiveOrganization` makes that the active organization of every new session, including the
  host session. The members page lists the session's active organization through Better Auth (`listMembers`), so the
  owner was looking at their personal workspace. A real owner picks A in the organization switcher first.
  **Fix instruction for Sonnet:** before opening `/dashboard/settings/members`, make A the owner's active organization the
  way the switcher does: `POST /api/auth/organization/set-active` with `{ organizationId: a.id }` on A's host, with the
  owner's cookie, through the spec's existing `send` helper. Assert a 200. Change nothing else in the test or product
  code.

## Follow-up (not for this PR)

- On an organization's address, a session whose active organization is a different org still gets that org from Better
  Auth's organization endpoints (members, invitations), while oRPC uses the host org. Opus to decide whether sign-in on an
  org host should set the host org as active. Logged in `docs/questions.md` as Q525.
