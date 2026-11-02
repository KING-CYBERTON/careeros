# P2-T07: Org admins manage their brand and domains from settings

**Status:** Approved (Opus, 2026-11-01). **Thread:** 1 Build. **Phase plan:** [P2-PHASE-PLAN.md](P2-PHASE-PLAN.md), decisions D1, D7, D10 and D11, and exit criteria 1 and 2.
**Branch:** `feat/P2-T07-branding-settings`. **Depends on:** T01, T02 and T05 (merged), T04 (`email_reply_to`) and T06 (the `organizationDomain` router). Start after both T04 and T06 merge.

## Goal

An owner or admin of the current organization opens **Settings → Branding**. From there they can set the app name, colours, font, legal links and email sender name and reply-to, and upload or remove the logo and favicon. They see a live preview, and they can add, check and remove custom domains. Members who are not admins cannot open it. The mobile app offers the same screens, as feature parity requires.

## Requirements

1. **API additions** (`packages/api/src/features/branding`):
   - Add `DELETE /branding/logo` and `DELETE /branding/favicon` (Q77). Owner or admin only. They null the key, enqueue storage cleanup the same way a replacement does, and bust the branding cache (`bustPublicBranding`).
   - Add a public, host-scoped lookup `GET /branding/host` (Q95). It takes no input and returns the public branding for the request's `HostContext`, or the platform default. It is rate limited like the other public reads. The mobile app uses it before sign-in.
2. **Web: Settings → Branding** (`apps/web/src/routes/dashboard/settings/branding.tsx`, plus a feature folder under `apps/web/src/features/branding`):
   - The settings nav shows the item only to owners and admins, from the existing role helpers. The route also guards: a member who is not an admin is redirected to settings with a toast, and the API refuses them anyway.
   - **Identity:** the app name (with the T01 length limit) and the email sender name and reply-to (T04).
   - **Colours:** primary and secondary, through a native colour input plus a hex text field, validated as `#rrggbb`. Show a contrast warning when the primary fails WCAG AA against its computed foreground, using `contrastRatio` from `@reactive-resume/utils/brand`.
   - **Font:** a select from the fixed list (`BRANDING_FONTS`).
   - **Logo and favicon:** upload through the T01 endpoints, with the accepted types and sizes stated. Help text recommends PNG or WebP for the logo, so it also shows in the mobile app (Q97). Each has a Remove button with a confirmation.
   - **Legal links:** support, terms and privacy, https only, validated client-side and by the server.
   - **Live preview:** a small sample header, button and card styled with the CSS variables T02 generates (`renderBrandCss` logic, or a shared client-side equivalent in `@reactive-resume/utils/brand`). It also shows the secondary colour (Q96). No full-page reload.
   - Save with optimistic UI, then invalidate the queries. Show a note that open tabs on the org host update within about a minute, because of the 60-second cache.
3. **Web: Settings → Domains** (same feature folder):
   - List the domains with their status badge, the DNS records to create (with copy buttons), the SSL status and the failure reason in plain words.
   - Add a domain, with the 5-domain cap shown. Recheck, respecting the rate limit and showing time remaining. Remove, with a confirmation that says the domain stops serving at once.
   - When the server reports "not configured" (no Cloudflare credentials), show a neutral notice instead of the form.
   - Also show the org's subdomain host from `ORG_HOST_PATTERN`, read-only, as the address that always works.
4. **Mobile parity** (`apps/mobile`):
   - The same Branding and Domains screens under settings, for owners and admins, using the same API. Colour entry may be hex text with a swatch. Uploads use the existing image-picker pattern.
   - The pre-sign-in screen uses `GET /branding/host` (Q95).
   - Mobile join from T03 Q91: on an org host where the signed-in user is not a member, show the same join or switch choice as the web `organization-access` page.
   - This is JS only, so it ships as an OTA update. Confirm with the fingerprint check described in CLAUDE.md, and say so in the PR.
5. **Strings:** use Lingui macros, and run `pnpm lingui:extract` for web and mobile. Use no upstream product name in new strings; the P2-C02 grep gate will enforce this.
6. **Docs:** update the mapped user guide under `docs/` for settings, if one exists, per CLAUDE.md "Keep product guides current". Use fictional screenshots only, or skip screenshots and say so.
7. **Upstream patches:** mark upstream edits with `CAREEROS:` and list them in `docs/UPSTREAM_PATCHES.md`, and add a line to `CHANGELOG-CAREEROS.md`.

## Tests

- **API:**
  - a logo or favicon delete by an owner nulls the key, enqueues cleanup and busts the cache;
  - a delete by a member gets FORBIDDEN;
  - a delete across orgs gets NOT_FOUND;
  - `GET /branding/host` returns org A's public fields on A's host, the default on the platform host, and never `email_from_name` or `email_reply_to`.
- **Web unit tests** (Testing Library):
  - the nav item is hidden for members;
  - colour and URL validation;
  - the contrast warning;
  - the preview updates when inputs change;
  - the domain list renders every status;
  - the "not configured" notice.
- **e2e** (Playwright): an admin changes the app name and primary colour and saves; a reload of the org host shows the new name in the title and the new `--accent`. A member cannot open Settings → Branding. A domain add shows the DNS records, with Cloudflare not configured in CI, so only the records step is checked.
- **Mobile:** node-test layout checks for the new screens, following existing `apps/mobile/scripts/*.test.mjs` patterns.

## Acceptance

All the tests above pass with the database configured and nothing skipped. Lint, format, boundaries and Lingui are clean. CI is fully green, e2e included, and the mobile node tests pass.

## Out of scope

Custom CSS (D11, Phase 3); per-org email domains; a design-system surface for the secondary colour.
