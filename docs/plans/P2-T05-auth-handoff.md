# P2-T05: Social and OIDC sign-in on organization hosts through a one-time handoff

**Status:** Approved (Opus, 2026-11-01). **Thread:** 1 Build. **Phase plan:** [P2-PHASE-PLAN.md](P2-PHASE-PLAN.md), decision D5. **Risks section:** the auth handoff, which is the riskiest piece of Phase 2. The Opus review covers open redirect, token replay, login CSRF and session fixation.
**Branch:** `feat/P2-T05-auth-handoff`. **Depends on:** T03 (#48).

## Goal

A user on an org host (for example `acme-careeros.ayopa.co.ke`) can sign in with Google, GitHub, LinkedIn, Apple or the generic OIDC provider, and ends up with a session on that org host only.

- OAuth providers keep a single registered redirect URI on the platform auth host.
- The platform host hands the result back to the org host with a one-time token. The token is bound to the user, the target host and the browser that started the flow, and it expires within 60 seconds.
- No cookie is ever shared across hosts (`crossSubDomainCookies` stays off).

## Flow

1. **Begin (org host).** The org-host sign-in page calls `POST /api/careeros/handoff/begin` on its own host with `{ provider, returnTo }`.
   - The server requires a `HostContext` of kind `"org"` (T03), and the host must be verified: a subdomain host now, and a verified custom domain once T06 lands.
   - It creates an `auth_handoff` row:
     - `id`: random, 128 bits or more;
     - `organization_id`;
     - `target_origin`: from the `HostContext`, never from the request body;
     - `return_to`: validated, see requirement 3;
     - `browser_binding_hash`: SHA-256 of a random 256-bit verifier;
     - `provider`;
     - `created_at`;
     - `expires_at`: now plus 10 minutes;
     - `token_hash`, `token_expires_at`, `user_id`, `redeemed_at`: all null at this point.
   - It sets the verifier in a cookie `careeros_handoff` on the org host only: `HttpOnly`, `Secure` when https, `SameSite=Lax`, `Path=/api/careeros/handoff`, Max-Age 600, and no `Domain` attribute.
   - It returns `{ url: "<platform origin>/auth/handoff?request=<id>" }`, and the SPA navigates there.
2. **Start (platform host).** The `/auth/handoff` page on the platform host reads the request id and calls `GET /api/careeros/handoff/request/:id`. That endpoint returns only `{ provider, organizationName }`, and only if the request exists, is unexpired and has not been issued. The page then starts Better Auth's social or generic-OAuth sign-in for that provider, with the relative `callbackURL` `/api/careeros/handoff/issue?request=<id>`. The page shows "Signing in to {organizationName}".
3. **Issue (platform host, after the OAuth callback).** `GET /api/careeros/handoff/issue?request=<id>`:
   - It requires a platform session.
   - In one transaction, it locks the row. The row must be unexpired, with `token_hash` still null.
   - It checks that the user may enter the org: they are a member, or T03's join rules allow them to join now. If T03 already exposes that as a function, reuse it. If they may not, redirect to `<target_origin>/auth/organization-access` (the T03 page) without a token.
   - It generates a 256-bit token and stores `token_hash` (SHA-256), `user_id` and `token_expires_at = now() + 60 seconds`, using database time.
   - It revokes the platform session if it was created by this flow (`session.created_at >= handoff.created_at`). A platform session the user already had stays.
   - It redirects with 302 to `<target_origin>/auth/handoff/redeem#token=<token>&request=<id>`, where `target_origin` comes from the row. The token goes in the fragment, so it never reaches server logs, the Referer header or proxies.
4. **Redeem (org host).** The SPA page reads the fragment, clears it with `history.replaceState`, and sends `POST /api/careeros/handoff/redeem { request, token }`, which carries the `careeros_handoff` cookie. The server:
   - requires that the request's host matches `target_origin` exactly, after T03 normalization;
   - in one statement, `UPDATE auth_handoff SET redeemed_at = now() WHERE id = $1 AND redeemed_at IS NULL AND token_expires_at > now() AND token_hash = $2 AND browser_binding_hash = $3 RETURNING user_id, organization_id, return_to`, comparing hashes in SQL and not in JS string comparison;
   - on zero rows, returns 400 with one generic error code, `handoff_invalid`, and gives no detail about which check failed;
   - on success, creates a Better Auth session for `user_id` through Better Auth's own internal session API and cookie helper (`internalAdapter.createSession` and `setSessionCookie`, or their 1.7 equivalents), sets the active organization to `organization_id`, clears the `careeros_handoff` cookie and returns `{ returnTo }`.
   - It must not call any endpoint that would make the session cookie shared across hosts.

## Requirements

1. **Table `auth_handoff`.** A new migration and Drizzle schema in `packages/db`.
   - It is pre-authentication and platform-global. Classify it in the isolation registry the same way as Better Auth's `verification` table, and say which class in the PR.
   - Index `expires_at` for cleanup.
   - Add a cleanup to the existing scheduled cleanup job that deletes rows where `expires_at < now() - interval '1 hour'`, using database time.
   - Store no tokens or verifiers in clear text.
2. **Rate limits.** Use the existing rate-limit config: `begin` gets 10 per minute per IP, `redeem` 20 per minute per IP, and `issue` follows the auth limits.
3. **`returnTo` validation.** It must be a relative path:
   - it starts with exactly one `/`;
   - it has no `//`, `\`, `/\`, control characters, scheme or `@` before the first `/`;
   - it is at most 512 characters;
   - it is parsed with `new URL(returnTo, target_origin)`, and the result's origin must equal `target_origin`.
   - Anything else becomes `/dashboard`.
4. **Which providers.** Every provider enabled in `socialProviders` and the generic OAuth `custom` provider. Passkeys, email and password, and magic links stay direct on the org host, as T03 left them.
5. **UI.**
   - On an org host, the web sign-in and sign-up pages send the social buttons through `begin` and no longer call Better Auth's social sign-in directly. On the platform host, nothing changes.
   - Add the `/auth/handoff` page on the platform host and the `/auth/handoff/redeem` page on org hosts. Both are reachable without a session. `handoff` must not be a reserved username segment conflict; add it to `RESERVED_SEGMENTS` if needed.
   - Errors land on the existing `/auth/error` page with a neutral message.
   - Mobile: the native app signs in on the platform host and is unchanged. Note this in `.agents/docs/mobile-release-handoff.md` if anything differs.
6. **CSRF and origin checks.** `begin` and `redeem` are POSTs that require the request `Origin` to equal the request host's origin, consistent with Better Auth's origin check.
7. **Logging.** Never log tokens, verifiers, fragments or full handoff URLs. Log request ids and outcome codes only.
8. **Upstream patches.** Mark upstream edits with `CAREEROS:` and list them in `docs/UPSTREAM_PATCHES.md`.

## Tests

- **Unit** (`returnTo`): `//evil.com`, `/\evil.com`, `https://evil.com`, `/%2F%2Fevil.com`, `javascript:alert(1)`, a path with CR/LF, and a 600-character path all become `/dashboard`. `/resumes?x=1` is kept.
- **Integration** (database plus the Hono app, through fake OAuth or by calling the issue step with a seeded platform session):
  - The happy path: begin, issue, redeem gives a session cookie on the org host only (no `Domain` attribute) and an active org set.
  - Replay: a second redeem with the same token gets `handoff_invalid`.
  - Expiry: a redeem 61 seconds after issue fails, with time moved through database time, not by sleeping.
  - Wrong host: redeem on org B's host with org A's token fails.
  - Missing or wrong browser cookie fails. This is the login-CSRF case, where an attacker sends a victim a valid token.
  - A token from request X used with request Y fails.
  - Issue for an expired request, or one already issued, does not issue a token.
  - A non-member with closed signup gets the organization-access redirect and no token.
  - The platform session created by the flow is revoked after issue, and a pre-existing platform session survives.
  - `target_origin` cannot be influenced by any request header or body field at begin. Try a forged `X-Forwarded-Host` with `TRUST_FORWARDED_HOST` off.
- **e2e** (Playwright, two org hosts through the existing host mapping used by T03's e2e): use a stub OIDC provider if the e2e environment has one. Otherwise cover begin and redeem with a seeded issue step, and say which in the PR.
- The cross-org auth fuzz (P1-Q10) inventory gains the four new endpoints, and the fuzz still shows no leaks.

## Acceptance

- All the tests above pass, and the existing auth, tenancy and e2e suites stay green.
- Lint, format and boundaries are clean, and CI is fully green, e2e included.
- The PR lists the Better Auth internals used and why they are stable in 1.7.12.

## Out of scope

Sharing sessions between org hosts; single sign-out across hosts; org-specific OAuth apps (Phase 3 or later); email-link flows landing on another host (see T04's question).
