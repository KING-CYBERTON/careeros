# P2-T04 review 1

**PR:** #52 · **Reviewer:** Opus · **Date:** 2026-11-01

## Checked

- **Org choice per send path.**
  - Reset, verify and change-email use only `HostContext`, never memberships, so a user in two orgs cannot get the wrong brand.
  - Invitations use the inviting org.
  - Career notifications use the row's org.
- **Definer function.** `careeros_email_branding` follows the T01 pattern: pinned `search_path`, EXECUTE revoked from PUBLIC and granted to `careeros_app` conditionally. It returns `email_from_name` and `email_reply_to` server-side only, and the public endpoints still omit them.
- **Header injection.**
  - The sender name has quotes, backslashes, angle brackets and control characters stripped, and is capped at 64 characters.
  - Reply-To is checked in four layers: Zod, the DB CHECK, the loader and the transport.
  - Subjects have control characters replaced.
- **Links.** `withLinkOrigin` changes only the scheme, host and port, and the port bug is fixed and tested. The origin comes only from `HostContext`, and a forged `X-Forwarded-Host` with trust off falls back to `APP_URL`.
- **Cache.** The cache moved to `@careeros/tenancy`, with a re-export so import paths are unchanged. There is one cache, and `bustPublicBranding` drops both keys.
- **Mobile.** The `store-review.test.mjs` regression is fixed by loading the real module. 63 of 63 pass.
- **Tests.** Run with a database, 0 skipped.

## Answers

- **Q110:** nothing more is needed for T05. An alias host keeping the `APP_URL` link is fine.
- **Q111:** accepted. Invitations keep the org subdomain host, which always works. T06 does not need to change it.
- **Q112:** for Phase 2, career notifications stay plain text with the `APP_URL` link. An HTML template and org-host links are a Phase 3 follow-up.
- **Q113:** accepted. The platform-brand fallback is safe and leaks nothing.
- **Q114:** T07's upload help recommends PNG (already in the T07 spec). Storing a PNG copy for email is a Phase 3 follow-up.
- **Q115:** accepted. `@careeros/tenancy` is server-only and sits below both auth and api, so it is the right owner.

## Verdict

Approved, to merge on fully green CI, e2e included.
