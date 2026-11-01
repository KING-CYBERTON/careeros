# P2-T08: Remove upstream branding (web, server, email, PDF, mobile)

**Status:** Approved (Opus, 2026-11-01). **Thread:** 1 Build. **Phase plan:** [P2-PHASE-PLAN.md](P2-PHASE-PLAN.md), decisions D9 and D10.
**Branch:** `feat/P2-T08-remove-upstream-branding`

## Goal

No user-facing surface names or links to the upstream product. Every place that showed the product name gets it from one source. In this task that source is a neutral platform default; T02 later fills it from the org's branding. The MIT attribution stays in `NOTICE` and on a new "Open-source licenses" page.

## Requirements

1. **One source for the product name.**
   - Add `packages/utils/src/brand.ts` (or the closest existing domain package, if `packages/utils` is the wrong owner per CLAUDE.md, and say why). It exports `PLATFORM_DEFAULT_APP_NAME = "CareerOS"` and a `BrandInfo` type: `appName`, `logoUrl?`, `faviconUrl?`, `supportUrl?`, `termsUrl?`, `privacyUrl?`.
   - Web: add a `useBrand()` hook and a non-React `getBrand()`. Both read `window.__BRAND__` when it is present (T02 will inject it) and fall back to the default otherwise. Do not inject anything in this task.
   - Server, email and PDF code takes the name as a parameter, with the default when none is given. Do not read the database here.
2. **Replace every user-facing occurrence** of the upstream product name, domain (`rxresu.me`), author and handle, upstream GitHub, Discord and Crowdin links, and the sponsor or donation prompts. Cover:
   - **Web:** the files under `apps/web/src` that a grep for "Reactive Resume", `rxresu.me` and `amruthpillai` finds (about 30 files). That includes the dashboard shell, auth layout, settings, share and download, ATS checker, ICS export, two-factor issuer, 404, SEO helpers, document title, and the marketing homepage (header, sections, FAQ, footer, share).
     - **Homepage:** replace the upstream marketing homepage with a minimal neutral landing page. It shows the app name, one line of copy ("Your career workspace") and Sign in and Create account buttons. Delete the upstream-specific sections, FAQ, testimonials, sponsor, GitHub stars and donation components rather than rewording them. Keep the route and the prerender working.
     - **Donation toast:** remove it and its trigger.
   - **Server:** `static/web.ts` and `static/seo.ts` (titles, OpenGraph, JSON-LD organization, canonical defaults), OpenAPI `metadata.ts` and `generator.ts` (API title and contact), and the MCP `server.ts` server name.
   - **Email:** `packages/email` templates (footer, subject prefixes). The sender display name defaults to the platform name.
   - **PDF:** `packages/pdf/src/html` document metadata (producer, creator) and the web-page catalogue strings.
   - **Mobile, for parity:** the `apps/mobile` files the same grep finds, including the auth header, server picker, settings, share, ICS and AI consent. For store-policy items (store listing, app icon and bundle id), change nothing and list them in `.agents/docs/mobile-release-handoff.md` as an explicit exception. Changing the app icon or bundle id needs a native build, so do not touch them.
   - **Two-factor issuer:** the `twoFactor({ issuer })` in `packages/auth/src/config.ts` uses the platform default.
   - **Static assets:** replace the upstream logo, icon and favicon files under `apps/web/public` with neutral placeholders: a simple wordmark SVG reading "CareerOS" and a matching favicon. Keep the file names and paths so references stay valid. The PWA manifest gets the platform name.
3. **Licenses page.** Add a public route `/licenses` on web, and a matching mobile screen. It shows the MIT notice from `NOTICE`, and the upstream copyright line must be preserved verbatim. Link it from the app footer or settings, and from the landing page footer.
4. **Translations.**
   - Change English source strings with Lingui macros, then run `pnpm lingui:extract`.
   - Do not hand-edit the other locales' translations, except to remove strings that no longer exist (extract does this). Leaving an untranslated string in another locale is acceptable.
   - Regenerate PDF translations (`pnpm pdf:translations`).
5. **Do not change:**
   - code identifiers;
   - package names (`@reactive-resume/*`);
   - env var names;
   - the `LICENSE` and `NOTICE` files;
   - `docs/` contributor docs (out of scope);
   - test fixtures, except where an assertion checks a removed string.

   Upstream-sync friendliness wins: change strings, not structure, wherever possible. Mark each edited upstream file with a `CAREEROS:` comment and list it in `docs/UPSTREAM_PATCHES.md`. Group the list by area rather than one line per string.

6. **Tests.**
   - Update the unit and e2e assertions that checked the old strings.
   - Add a unit test for `getBrand()`, covering the fallback and the `__BRAND__` override.
   - Do **not** add the CI grep gate itself. That is P2-C02. Do put the exact grep command you used to verify zero remaining user-facing hits in the PR body.

## Acceptance

- careeros-ci is fully green: static (lint, format, boundaries, typecheck), unit and e2e.
- The grep in the PR body returns no user-facing hits. Remaining hits are only in identifiers, package names, `NOTICE`, `LICENSE` and the licenses page.
