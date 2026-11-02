# P5-T01: Browser extension scaffold, org address setup and branded popup

**Status:** Approved (Opus, 2026-11-02). **Thread:** 1 Build. **Plan:** [GTM-PLAN.md](GTM-PLAN.md), decisions G5 and G6 (permissions only).
**Branch:** `feat/P5-T01-extension-scaffold`. **Questions:** start at Q230.

## Goal

Create `apps/extension`: a Manifest V3 extension for Chrome and Edge that builds, lints and tests in the monorepo. On first run, the user connects it to their organization's address and sees that org's name and logo. Sign-in is P5-T02, and clipping is P5-T03.

## Requirements

1. **Workspace** `apps/extension` (package name `extension`):
   - TypeScript and React 19, built with Vite through `vp` like the web app, outputting an unpacked extension in `apps/extension/dist`.
   - Turbo tags: `app:extension`, `runtime:browser`. Add the tag to the boundaries config, so the extension may depend only on browser-safe packages (`@reactive-resume/ui`, `@reactive-resume/schema`, `@reactive-resume/utils`) and never on server packages.
   - Lint, format, typecheck and test scripts like the other apps, wired into CI through the existing Turbo tasks.
   - Use the shared UI primitives and Tailwind setup from `packages/ui` where they fit a 360 px popup.
2. **Manifest V3:**
   - Name "Job Clipper". It carries no product brand, and the org's brand appears at runtime (G5).
   - `action` with a popup, and a service worker background.
   - Permissions: `activeTab`, `storage`, `scripting` only.
   - `optional_host_permissions: ["https://*/*"]`. The extension requests permission for the one org origin the user enters, at the moment they enter it, through `chrome.permissions.request`. No `host_permissions` granted at install.
   - A strict content security policy for extension pages: no remote scripts and no `unsafe-eval`.
   - Icons are a neutral placeholder set in `apps/extension/public`.
   - The version comes from `apps/extension/package.json`.
3. **Org address setup:**
   - The first-run screen asks for "Your organization's address". It accepts a host or an https URL and normalizes it to an origin. http is accepted only for `localhost` in development builds.
   - Validate it by calling `GET <origin>/api/branding/host` (P2-T07). It must answer with the CareerOS shape. Show the org name and logo for the user to confirm. A host that is not a CareerOS server gets a clear error.
   - Store `{ origin, orgName, logoUrl, primaryColor }` in `chrome.storage.local`, with a "Change organization" action that clears it (and, later, the token).
   - Apply the org's primary colour and logo to the popup header. Treat everything from the server as data: escape text, and load the logo only from the same origin over https.
4. **Popup states** in this task: "not connected" (setup), "connected, not signed in" (a disabled "Sign in" button with a note that sign-in is coming), and a placeholder for the clip view. Keep the structure ready for T02 and T03.
5. **Server side:**
   - Make sure `GET /api/branding/host` answers cross-origin requests from `chrome-extension://` and `moz-extension://` origins. It is public and read-only, with no credentials. Add only the CORS headers this route needs, and keep every other route's CORS unchanged.
   - Mark the edit `CAREEROS:` if the file is upstream.
6. **Build and package:** a `pnpm --filter extension build` that produces `dist/`, and a `pack` script that zips it as `job-clipper-<version>.zip`. CI upload is P5-C01, not this task.
7. **Tests:**
   - Unit tests for address normalization (host, URL, trailing paths, uppercase, IDN, http refused except localhost in development).
   - Unit tests for branding-response validation (the wrong shape is refused).
   - A test that the built manifest contains exactly the permissions listed above.
   - A Playwright test that loads the unpacked extension in Chromium against the local test server, completes setup, and sees the org name. If loading extensions in the CI Playwright setup is not possible, say so in a question and keep the unit tests.
8. **Docs:** a short `apps/extension/README.md` covering how to build, load unpacked in Chrome and Edge, and what each permission is for. Add a CHANGELOG line. Note in `AGENTS.md` or the ownership map that `apps/extension` owns the clipper (mark it `CAREEROS:`).
9. **Parity note:** the clipper is desktop-browser-only by nature. Record that in `.agents/docs/mobile-release-handoff.md` as an accepted exception (decided in the GTM plan).
10. Lingui for popup strings, if the setup is small enough to share the web catalogue; otherwise keep the strings in one module and log a question.

## Acceptance

- careeros-ci is fully green, including boundaries.
- The built manifest has only `activeTab`, `storage` and `scripting`, plus optional host permissions.
- Setup against a CareerOS host shows that org's name and logo, and a non-CareerOS host is refused.
