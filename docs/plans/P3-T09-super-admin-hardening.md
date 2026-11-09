# P3-T09: Super Admin hardening from the P3-Q03 findings

**Status:** Approved (Opus, 2026-11-08). **Thread:** 1 Build. **Plan:** P3-PHASE-PLAN.md (D6, D7); P3-Q03 findings Q420 to Q423. **Depends on:** P3-T07 merged (#93). P3-Q03 (#97) goes green once this merges.
**Branch:** `fix/P3-T09-super-admin-hardening`. **Questions:** start at Q440.

## Goal

Close the support-session gap that P3-Q03 found, and stop the platform audit helper from writing rows that look like console actions.

## Requirements

1. **Support sessions cannot mint lasting credentials (Q421, release blocker).** In a live support session, refuse every Better Auth path that creates, refreshes or hands out a credential, or that ends the member's other sessions. Add these to `IMPERSONATION_REFUSED_AUTH_PATHS` in `packages/platform-admin/src/policy.ts`:
   - the whole `/oauth2/` prefix (client create and register, consent, authorize, token);
   - `/get-access-token` and `/refresh-token`;
   - `/revoke-session`, `/revoke-sessions` and `/revoke-other-sessions`;
   - any device-authorization approval path not already refused.
     Match on the normalized path (case, trailing slash, double slashes, encoded characters), not on a raw string prefix. Refused calls answer 403 with the existing support-session error code and write nothing.
2. **The refused list is derived, not hand-kept, where possible.** Add a test that reads Better Auth's published endpoint list and fails when a path that issues a token, creates a client, links an account or ends sessions is not refused in a support session. Take the allowed set as an explicit list with a reason per entry.
3. **Console-looking audit rows (Q422).** `careeros_audit_platform` stays callable by `careeros_app`, because billing transitions and webhooks use it with no user actor. It must now refuse any `action` starting with `admin.` (SQLSTATE 42501). Only the console's definer functions write `admin.*` rows, through their own INSERT. `careeros_set_org_plan` and `careeros_set_subscription` stay as they are: billing calls them with a NULL actor for system transitions by design. Document this in the function comments and in docs/questions.md Q422.
4. **Manual payment 2FA (Q423):** no change. The console wrapper requires 2FA, and the T04 function remains a billing-internal path. Record this in Q423.
5. **Migration:** a new forward migration that replaces `careeros_audit_platform`, plus a `down.sql`. Do not edit an applied migration.
6. Mark upstream edits `CAREEROS:`, list them in docs/UPSTREAM_PATCHES.md, and add a CHANGELOG line.

## Tests

- The P3-Q03 test "cannot mint a credential that outlives the session ..." passes unchanged once #97 is merged with this. Add equivalent tests in this PR so it is green on its own: each new refused path answers 403 in a support session and works normally outside one. Include a normalization bypass attempt, such as `/OAuth2/create-client` and `/oauth2//register`.
- `careeros_audit_platform` with an `admin.` action raises 42501 and writes nothing. A billing action still writes.
- Existing billing, platform-admin and impersonation suites stay green.

## Acceptance

- careeros-ci is fully green.
- After this and #97 merge, no support session can obtain a credential that outlives it.
