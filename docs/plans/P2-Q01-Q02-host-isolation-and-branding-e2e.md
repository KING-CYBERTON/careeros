# P2-Q01 and P2-Q02: e2e proof that hosts isolate orgs and show their own brand

**Status:** Approved (Opus, 2026-11-02). **Thread:** 2 QA. **Phase plan:** [P2-PHASE-PLAN.md](P2-PHASE-PLAN.md), exit criteria 1 and 3. **Depends on:** T02 to T06 (merged). The P2-Q02 settings step depends on T07; if T07 has not merged, seed branding through SQL with `withSeedPool` and say so.
**Branch:** `test/P2-Q01-Q02-host-e2e`.

## Goal

CI proves, in a real browser against the production build, two things. First, a session from org A's host cannot act in org B on B's host (Q01). Second, two orgs on two hosts each show their own branding on every surface the phase plan names (Q02).

## Setup

- Reuse the host mapping from `careeros-auth-handoff.spec.ts`: `ORG_HOST_PATTERN={slug}.orgs.test`, already set in the CI e2e job, plus the Chromium `--host-resolver-rules=MAP *.orgs.test 127.0.0.1` launch option. Put the shared org-host helpers in `tests/e2e/fixtures`, and have the handoff spec import them so they are not duplicated.
- Create two orgs, A and B, each with its own owner and member. Seeding goes through the existing fixtures or `withSeedPool` (P1-Q07). Never seed on production data.

## P2-Q01: host isolation

1. **Isolation registry:**
   - confirm every Phase 2 table is registered: `organization_branding`, `organization_settings`, `organization_domain`, the Cloudflare cleanup queue and `auth_handoff`;
   - add a unit assertion that the unclassified-tables pending list is still empty.
2. **e2e:** `tests/e2e/specs/careeros-host-isolation.spec.ts`
   - Sign in as A's member on A's host. Copy the session cookie into a request to B's host, through the `Host` header in API calls and the resolver in the browser.
   - `/api/rpc` calls, a resume list, a resume get by A's id and an org-scoped mutation all fail on B's host. Use the error codes T03 defined: the join-or-switch response or `key_org_mismatch`. B's data never appears.
   - Visiting B's host in the browser with A's cookies set for B's host shows the organization-access page, never B's dashboard data.
   - An API key bound to org A, used on B's host, is refused. The same key on A's host works.
   - An unknown org-shaped host (`nope.orgs.test`) returns the not-set-up page with a 404 and `noindex`.
   - A custom domain row in `pending` (seeded) does not resolve and fails closed.
3. **Fuzz:** extend the P1-Q03 cross-org ID fuzz with an org-host pass. Replay the same operation inventory on B's host using A's credentials and A's ids, and record zero leaks. Keep the platform-host pass unchanged.

## P2-Q02: branding on every surface

`tests/e2e/specs/careeros-branding.spec.ts`. Give A and B distinct app names, primary colours, favicons and logos. Use PNG fixtures, committed under `tests/e2e/fixtures/branding/`. Set them through the T07 settings UI for org A, which also covers T07 end to end, and through SQL or the API for B.

On each host, assert:

- **Sign-in page:** the app name is visible and the logo `src` points to that org's asset path.
- **App shell after sign-in:** the header shows the name and logo, and computed `--accent` on `:root` equals the org's primary colour.
- **Browser title and favicon:** `document.title` contains the org's name, and the `link[rel=icon]` href is that org's favicon path.
- **Public resume page:** a public resume of a member, served on the org host, carries the org name and favicon.
- **Emails:** trigger a password reset on each host. In CI without SMTP the server logs the rendered email (development logging) or uses the existing e2e mail capture, whichever the repo already has; say which. Assert the subject and sender display name carry the right org, and the link points to the right host.
- **Isolation of brand:** A's name, colour and asset paths never appear in B's HTML, and the reverse. Check this on the raw HTML response.
- **Caching:** responses carry `Vary` with `Host`.

## Acceptance

Both specs pass in CI, e2e included, with no retries. The handoff spec still passes, now using the shared helpers. The fuzz reports zero leaks on both passes. No `test.skip` without a written reason tied to an environment limit, and no skipped required case.

## Out of scope

Live staging checks with real DNS and TLS (P2-C01 and the staging verification).
