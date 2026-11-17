# P3-Q03: Super Admin security tests

**Status:** Approved (Opus, 2026-11-08). **Thread:** 2 QA & Testing. **Plan:** P3-PHASE-PLAN.md (Q03, D6, D7). **Depends on:** P3-T07 merged. Start only after it merges.
**Branch:** `test/P3-Q03-super-admin-security`. **Questions:** start at Q420.

## Goal

Prove that the Super Admin console cannot be reached or abused by anyone but platform staff, that every cross-org action goes through an audited definer path, and that impersonation is limited, visible and logged. This completes the audit-log work for feature 29 together with P3-T07.

## Requirements

Tests only. A product defect found here is logged as a question and reported to Opus with the failing test. Do not fix product code in this task unless the fix is a one-line guard that Opus approves in the question.

1. **Access** (integration and e2e):
   - Every Super Admin procedure and route refuses an anonymous caller, a member, an org admin, an org owner, a banned platform admin, a platform admin without 2FA, a clipper token and an API key.
   - Every Super Admin procedure and route refuses calls on an org host or a custom domain, even from a real platform admin.
   - Build the list of procedures from the router, not by hand, so a new procedure is covered automatically, and fail if one is missing from the test's expected-refusal table.
2. **Definer paths:**
   - A test enumerates every function the Super Admin service calls.
   - Each is SECURITY DEFINER with `search_path = pg_catalog, public`, with EXECUTE revoked from PUBLIC and granted only to `careeros_app`.
   - Each checks for a non-banned admin actor inside the function.
   - Each writes exactly one `audit_log` row with actor, action, target org and timestamp.
   - Calling each function directly as `careeros_app` with a non-admin actor id raises and writes nothing.
   - `careeros_app` still has no BYPASSRLS.
3. **Audit log:**
   - `careeros_app` cannot UPDATE or DELETE `audit_log` rows.
   - An org admin sees only their own org's entries.
   - Super Admin actions on org A never appear in org B's view.
   - Each action named in P3-T07 (suspend, unsuspend, plan change, manual payment, impersonation start and end, announcement) writes its row.
4. **Impersonation:**
   - It ends at its time limit; after expiry the next request is refused.
   - A banner is shown on every page while it lasts (e2e).
   - The impersonator cannot change the impersonated user's password, 2FA, passkeys, email or API keys, cannot start another impersonation, and cannot reach the Super Admin console while impersonating.
   - Both start and end are audited, including an end by expiry.
5. **Suspension:** a suspended org's members can read but not write, per `SUSPENDED_ORG_ALLOWED_WRITES`. Unsuspending restores writes. Both are audited.
6. **Fuzz:** add the Super Admin routes to the cross-org fuzz inventory and the procedure inventory with the expected refusals for non-staff.
7. Mark upstream edits `CAREEROS:` and list them in docs/UPSTREAM_PATCHES.md. Add a CHANGELOG line.

## Acceptance

- careeros-ci is fully green, including the isolation, inventory and skipped-suite guards, and no new suite is skipped.
- Every item above has at least one test that fails when the protection is removed. Show one example of this in the PR body.
