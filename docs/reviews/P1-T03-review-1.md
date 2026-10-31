# P1-T03 Signup org, invitations and org switching: Opus review 1

**Branch:** `feature/P1-T03-signup-invites` @ `039423c7b` · **Spec:** [plans/P1-T03-signup-invites.md](../plans/P1-T03-signup-invites.md) · **Verdict:** Approved after one small change (M1)

This is a solid implementation. The skip rule for invited sign-ups needs both the id and a matching pending invitation for that email, so neither alone is enough. The admin role-change gap in the plugin was found and closed on the server. The personal org, its owner member and the active-session update happen in one transaction. The route tree was regenerated with the official generator, not edited by hand.

## Findings

- **M1 (Medium, Q17):** `deleteAccount` refuses even when another owner remains. Allow deletion when every shared org the user owns still has at least one other `owner`. Refuse only when the user is the **last** owner of an org with other members. Add a test for each case.
- **Low:** the 250 ms settle delay in the auth integration test's `afterAll` is accepted, because it covers test teardown only. If it shows up again in CI, fix the root cause by terminating the backends before `DROP DATABASE` with `pg_terminate_backend` or `WITH (FORCE)`.

## Questions answered

- **Q14:** keep requiring a verified email before accepting. Someone can hold an invitation id without owning the mailbox, for example when the inviter shares the link. The accept page's "verify first" state is the right UX.
- **Q15:** no column in Phase 1. A new login gets the oldest membership, and the session remembers switches. Phase 2's host-based resolution makes this moot.
- **Q16:** the `user.delete.before` cleanup of sole-member orgs is confirmed.
- **Q17:** see M1.
- **Q18:** refusing `createApiKey` when the active org is stale is confirmed (fail closed).

## Notes for P1-T04

Users who signed up through an invitation and never accepted have no org. After T04 they reach only the allow-listed procedures and the "accept your invitation" notice. That is intended.
