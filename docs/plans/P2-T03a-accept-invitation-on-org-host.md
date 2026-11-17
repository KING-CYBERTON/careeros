# P2-T03a: invitees on an organization's address reach the invitation, not "You're not a member"

**Status:** Approved (Opus, 2026-11-10). Bug fix to P2-T03. Found by human QA on staging, test **OM-03 Invite an admin**
(priority high).

## Problem

An org owner invites someone (role Admin or Member). The invitee opens the email link
`https://<org-host>/auth/accept-invitation/<id>`, signs in or creates an account, and lands on
"You're not a member of ayopa" (`/auth/organization-access`) instead of the "Join ayopa" page. The invitation stays
pending. It happens every time, for new and existing accounts, in Chrome, with owner and invitee in separate browsers.

## Cause

1. A signed-in invitee already has an active organization (their personal one, or another org), so
   `loadRootContext` (`apps/web/src/libs/root-context.ts`) calls `client.organization.entitlements()` on every
   navigation, including `/auth/accept-invitation/$id`, `/auth/login` and `/auth/register`.
2. `entitlements` is a `protectedProcedure`. On an org host, `resolveOrgForAuthentication` refuses a non-member, so it
   answers `FORBIDDEN` with `data.code = ORG_HOST_NOT_MEMBER`.
3. The web oRPC `onError` interceptor (`apps/web/src/libs/orpc/client.ts`) calls `handleOrgHostError`
   (`apps/web/src/libs/orpc/org-host.ts`), which does `window.location.assign("/auth/organization-access")` for any path
   except that page itself. `loadOrganizationFlags` catches the error, but the redirect has already been issued.

So the one page that turns a non-member into a member is unreachable for non-members on the org host. The server side is
correct and is not changed: Better Auth's `getInvitation` / `acceptInvitation` do not go through the host rule, and
`guardOrgHostSignUp` already admits sign-up with a pending invitation.

## Change

1. `handleOrgHostError` must not redirect while the user is on the way to an invitation:
   - the current path is the accept-invitation page (any path that `invitationIdFromCallback` in
     `apps/web/src/features/auth/invitation.ts` recognises, applied to `location.pathname`), or
   - the current URL's `callbackURL` search parameter points to the accept-invitation page (this covers `/auth/login`,
     `/auth/register` and the 2FA pages that carry the callback back to the invitation).
     Widen the injected `location` type to include `search`. Reuse `invitationIdFromCallback`; do not add a second regex.
     Keep the existing exemption for `ORG_ACCESS_PATH`.
2. No change to `loadRootContext`: it already swallows the error and shows no features until the read succeeds, which is
   the right state for a non-member. After accepting, `finish()` invalidates the session and queries, so entitlements
   resolve against the host org.
3. Mark the edits with `CAREEROS:` comments referencing P2-T03a. These files are CareerOS files already, so
   `docs/UPSTREAM_PATCHES.md` does not change unless a touched file is upstream.
4. Mobile parity: mobile has no accept-invitation screen (invitations are accepted on the web link), and its handler only
   marks the host blocked. No mobile change. Say so in the PR.

## Tests

- Unit (`apps/web/src/libs/orpc/org-host.test.ts`): no redirect on `/auth/accept-invitation/<id>`; no redirect on
  `/auth/login?callbackURL=%2Fauth%2Faccept-invitation%2F<id>` and on `/auth/register?...` the same; still redirects on
  `/auth/login` with no callback or with `callbackURL=/dashboard`; still redirects on `/dashboard/resumes`; existing cases
  keep passing.
- E2E (`tests/e2e/specs/careeros-host-isolation.spec.ts`, using its existing org-host fixtures): owner of org A invites
  an existing user who belongs only to their own org, with role Admin; the invitee opens the accept link on org A's host
  while signed in, sees "Join <org>", accepts, lands on `/dashboard` on org A's host, and the owner's member list shows
  them as Admin. If the fixtures cannot express an org host in e2e, log it in `docs/questions.md` and ship the unit tests.

## Out of scope

Server host rules, the organization-access page's copy, invitation emails.

## Acceptance

- On staging, OM-03 passes for a new account and for an existing account, with role Admin and with role Member.
- A signed-in non-member visiting any other page on the org host still lands on "You're not a member".
- Static, unit and e2e CI green.
