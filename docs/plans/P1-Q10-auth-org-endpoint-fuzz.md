# P1-Q10: Cross-org fuzz of the Better Auth organization endpoints

**Status:** Approved (Opus, 2026-11-01). **Thread:** 2 QA. **Source:** Phase 1 exit security review, M1, and P1-Q03 review F2.
**Branch:** `test/P1-Q10-auth-org-fuzz`

## Goal

Prove that a user in Org B cannot read Org A's members or invitations, administer Org A, or join it, through any `/api/auth/organization/*` endpoint. Also prove that the MCP fuzz is not passing trivially.

## Requirements

1. **Reuse the fixtures.** Use `tests/e2e/fixtures/two-orgs.ts`. Extend it so Org A also has:
   - a second member (A2, role `member`);
   - one pending invitation to an email that B does not control.

   Return the ids.

2. **Inventory.**
   - List the organization plugin's endpoints from the running auth instance. `auth.api` keys or the Better Auth OpenAPI output both work, if available. Fall back to an explicit list only if neither can be enumerated, and comment why.
   - The test fails if an organization endpoint is neither exercised nor in a commented skip list. The only valid skip reason is "takes no organization, member or invitation id".
3. **Spec** `tests/e2e/specs/cross-org-auth-fuzz.spec.ts`. As B, using B's session cookie, call every endpoint with Org A's ids, including at least:
   - get-full-organization, list-members, list-invitations, get-invitation
   - update, delete, set-active
   - add-member, remove-member, update-member-role
   - invite-member, cancel-invitation, accept-invitation, reject-invitation
   - leave

   Also cover `organizationId` and `organizationSlug` variants wherever the endpoint accepts them.

4. **Assertions.**
   - Every response is a 4xx, or an empty or null body, and never carries Org A's name, slug, member emails or invitation id.
   - Afterwards, a snapshot as A (members, roles, invitations, org name and slug) matches the one taken before the run.
   - B's session does not end up with `activeOrganizationId` set to Org A.
   - Then, as B, call an oRPC protected route and confirm it still acts in Org B.
5. **API key.** Create a B API key with `organizationId` set to Org A, through whatever path the API allows. If the API refuses, assert that it refuses. If it accepts, assert that requests with that key are refused (FORBIDDEN, no org).
6. **MCP control call (Q03 F2).** In the existing cross-org MCP fuzz, call one id-taking tool as A with A's own id, and assert it returns A's data. This proves the scanner would detect a leak.
7. **Failures.** Any leak is a release blocker. Log it in docs/questions.md and stop. Do not weaken an assertion, and do not change auth behaviour in this task.
8. **Runtime.** The spec must stay under 90 seconds in CI.

## Acceptance

- careeros-ci is fully green, e2e included.
- The inventory check proves that every organization endpoint is covered.
