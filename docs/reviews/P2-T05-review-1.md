# P2-T05 review 1

**PR:** #51 · **Reviewer:** Opus · **Date:** 2026-11-01 · **Focus:** open redirect, replay, login CSRF, session fixation, host spoofing.

## Checked

- **Open redirect.**
  - `returnTo` is validated at begin, and the result's origin must equal the target origin.
  - Issue redirects only to `target_origin` read from the row, after `resolveTargetHost` re-resolves it through T03 and checks that the org and origin still match.
  - The denied path redirects only to `/auth/organization-access` on that same origin.
- **Replay.** Redeem is one `UPDATE … WHERE redeemed_at IS NULL AND token_expires_at > now() AND token_hash = … AND browser_binding_hash = … AND target_origin = … AND organization_id = … RETURNING`. It is atomic and uses the database clock, so a second redeem gets zero rows. Issue locks the row (`FOR UPDATE`) and requires `token_hash IS NULL`, so a request issues at most once.
- **Login CSRF.** The verifier cookie is host-only on the org host, and its hash must match. A token handed to a victim fails without the attacker's cookie. Tested.
- **Session fixation.** The session is created fresh on redeem through Better Auth's own `createSession` and `setSessionCookie`, with no `Domain` attribute. The server-only endpoints return 404 over HTTP, and a test asserts this.
- **Host spoofing.** The target origin comes only from `HostContext`, and a forged `X-Forwarded-Host` with trust off is tested.
- **Secrets:** stored hashed, with the token in the URL fragment. Logs carry request ids and outcomes only.
- **Platform session:** revoked only when the flow created it.
- **Tests:** 24 handoff integration tests, run with a database, 0 skipped.

## Findings

- **L1 (Low, record only).** `issue` is a GET with side effects: an open-signup join, and issuing a token. A third party can send a signed-in platform user to `issue?request=<attacker's request>`. The user joins an open-signup org they could join anyway. The token lands in the victim's browser and cannot be redeemed without the attacker's verifier cookie, and the victim's pre-existing session is not revoked. No data or session crosses over. A `Sec-Fetch-Site` gate cannot be added, because the legitimate arrival is a cross-site redirect from the provider. Accepted.

## Answers

- **Q105:** accepted for Phase 2. A stranger can create a platform account (personal org, D6) through a closed org's button, but gets no token and no access to the org. Carrying the org in OAuth state, so that sign-up on an invite-only org can be refused upstream, is a Phase 3 follow-up.
- **Q106:** confirmed. Only members and open-signup joins get in. Pending invitations are accepted through the invitation flow, not the handoff.
- **Q107:** accepted. `tenancyAllowList` is the right class for a pre-auth table that carries `organization_id`.
- **Q108:** accepted. The placeholder Google values are not secrets, and the `orgs.test` pattern does not touch other specs. If the extra Google button breaks an existing e2e selector, fix the selector rather than removing the provider.
- **Q109:** all accepted. The extra redeem conditions tighten the check. `request/:id` shares the issue budget. Purging in both schedulers is fine because the purge is idempotent. The DB clock is used for "created by this flow". 403 for origin failures and 400 for token failures do not leak which token check failed.

## Verdict

Approved, to merge on fully green CI, e2e included. This is the first CI run of `careeros-auth-handoff.spec.ts` and the new fuzz step.
