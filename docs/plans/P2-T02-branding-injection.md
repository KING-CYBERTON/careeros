# P2-T02: Serve each organization's branding in the app shell

**Status:** Approved (Opus, 2026-11-01). **Thread:** 1 Build. **Phase plan:** [P2-PHASE-PLAN.md](P2-PHASE-PLAN.md), decisions D1 and D10. **Risks section:** cache poisoning.
**Branch:** `feat/P2-T02-branding-injection`. **Depends on:** T01 (merged), T08 (merged) and T03 (#48).

## Goal

On an org host, the HTML shell arrives already branded with that org's name, colours, font, favicon and logo. No flash of the platform brand appears, and no per-org build is needed. On the platform host, the neutral platform default is used.

## Requirements

1. **Brand resolution on the server.** In `apps/server/src/static/web.ts`, use the request's `HostContext` from T03.
   - On `kind: "org"`, load the public branding with `careeros_public_branding` (T01) and map it to `BrandInfo` from `@reactive-resume/utils/brand`.
   - Asset URLs point to `/api/branding-assets/<org>/<file>` (T01).
   - Cache the result in-process for 60 seconds per org. Bust it on `branding.update` and on uploads, in the same process.
2. **Injection into every HTML shell response.** That covers the SPA shell, the prerendered landing page and the public resume pages served under an org host.
   - `<title>` and the meta and OpenGraph site name use the app name.
   - `<link rel="icon">` and `apple-touch-icon` point to the favicon when it is set. Otherwise keep the default.
   - A `<style id="brand">` block sets CSS variables mapped to the existing theme tokens in `packages/ui`: primary and secondary colours, plus a readable foreground computed server-side by WCAG contrast. It also sets the font-family variable, with an `@font-face` or link only for the fixed font list. Find the token names the UI already uses and say which ones in the PR.
   - A `<script>` setting `window.__BRAND__ = {...}`.
     - Serialize it safely: escape `<`, `>`, `&`, U+2028 and U+2029, so no value can break out of the script.
     - Every value has already passed T01's validation, but escape anyway.
     - Use a nonce if the app has a CSP with nonces. Otherwise follow the existing inline-script pattern in `web.ts`.
   - The manifest: serve `/manifest.webmanifest` per host, with the name, short name, theme colour and icons from the branding.
3. **Caching (cache-poisoning risk).**
   - HTML and manifest responses add `Vary: Host`.
   - The Cloudflare cache tags that `web.ts` sets include a host- or org-specific tag, so a purge per org is possible.
   - Prerendered HTML is never cached across hosts without the brand block. Inject at serve time, not at build time.
   - Hashed `/assets/*` stay unchanged and shared.
4. **SPA.**
   - `useBrand()` and `getBrand()` from T08 now pick up `__BRAND__`.
   - Use the brand for the app shell header and logo, the sign-in and sign-up pages, the document title helper, and the 404 page.
   - Add the "no such organization" view (T03 Q92). An unknown org-shaped host shows a neutral page: "This address isn't set up yet."
5. **Mobile parity (D10).** After sign-in, the mobile app fetches `branding.publicBySlug`, using the org of the current session's host, or the platform default. It applies the app name, logo and primary colour to the shell header and the sign-in screen. The store listing and app icon are unchanged, as already recorded.
6. **Tests.**
   - Server unit tests, given a fake `HostContext` and branding:
     - the injected title, favicon, CSS variables, `__BRAND__` and manifest;
     - XSS: an app name containing `</script><script>alert(1)</script>` and quotes is rendered inert in every position;
     - `Vary: Host` is present;
     - the platform host gets the defaults;
     - an unknown org host gets the "not set up" shell with status 404.
   - Web unit test: `useBrand()` reads the injected values.
   - E2E: leave the two-host branding e2e to P2-Q02. Make sure the existing suite stays green.
7. Mark upstream edits with `CAREEROS:` and list them in `docs/UPSTREAM_PATCHES.md`. Log open points in `docs/questions.md`, using the next free number, then stop that part.

## Acceptance

- careeros-ci is fully green.
- With `ORG_HOST_PATTERN` unset, the platform shell is unchanged apart from the brand block holding the defaults.
