# P5-T02: Clipper sign-in: device flow, host-bound tokens and revocation

**Status:** Approved (Opus, 2026-11-02). **Thread:** 1 Build. **Plan:** [GTM-PLAN.md](GTM-PLAN.md), decision G6. **Depends on:** P5-T01 merged.
**Branch:** `feat/P5-T02-clipper-sign-in`. **Questions:** start at Q260.

## Goal

A member signs the Job Clipper in to their organization without typing a password into the extension. The extension gets a token that works only on the org address it was issued for, only for what the clipper needs, and that the member can revoke from their settings.

## Requirements

1. **Server: device authorization.**
   - The installed Better Auth (1.7.12) ships the `device-authorization` plugin. Use it, configured in `packages/auth/src/config.ts` (mark `CAREEROS:`). Read the plugin's code and types in `node_modules` before wiring it, and follow what the installed version does, not memory. If the plugin cannot meet a requirement below, log a question and stop that part.
   - A fixed client id for the clipper, `careeros-job-clipper`, with no secret. No other client id is accepted.
   - Device code lifetime 10 minutes, polling interval 5 seconds, user code of 8 characters from an unambiguous alphabet. The device-code and token endpoints are rate limited per IP and per device code, using the existing rate-limit storage.
   - **Host binding.** The device code records the host it was requested on (the request host after the existing org-host resolution). Approval only works on that same host, by a signed-in member of the org that host resolves to. The issued token stores that host and org, and every use of the token is refused unless the request host resolves to the same org. A token used on the platform host, another org host or a custom domain of another org is refused with 401. A custom domain and the org subdomain of the same org count as the same org.
2. **Approval page** on the web app: `/device` (or the plugin's path, if it fixes one).
   - The member signs in if needed (normal per-host session), enters or confirms the user code, and sees what is being granted: "Job Clipper on <org name> can read your profile name and save jobs to your tracker". Approve and Deny buttons.
   - Lingui strings. The page is branded like the rest of the org host.
   - Mobile parity: none needed, because approval happens in a desktop browser. Record that in the parity note from P5-T01.
3. **Token scope.** The clipper token is not a full session.
   - It may call only: the current user's name and avatar, the org's branding, and the applications create procedure (P5-T03 uses it), plus a `clipper.whoami` procedure that returns the user name, org name and the token's expiry.
   - Every other procedure refuses it with 403. Enforce this centrally where the request's auth is resolved (reuse the shared resolution for API keys, bearer tokens and cookies, per AGENTS.md), with an allow-list of procedure paths, not in each procedure.
   - Lifetime 90 days, sliding: each use within the last 30 days extends it to 90 days from now. A suspended org (P3-T02) can still sign in but the save call is refused like any other write.
4. **Revocation.**
   - A "Connected apps" section in Settings (web, and the same list on mobile for parity) lists the member's clipper tokens: org, created, last used, a short device label from the extension's user agent. Each has a Revoke button. Revocation takes effect on the next request.
   - Removing a member from the org, deleting the user, or a platform suspension revokes their clipper tokens for that org.
   - Org admins do not see members' tokens in this task.
5. **Extension.**
   - The "Sign in" button starts the flow against the stored origin: it shows the user code and a button that opens `<origin>/device?user_code=...` in a new tab, then polls until approved, denied or expired, honouring `slow_down`.
   - Store the token in `chrome.storage.local` with the origin it belongs to. Never send it to any other origin: the API client refuses to attach it when the request origin differs from the stored origin.
   - "Signed in as <name>" in the header, with Sign out (revokes the token on the server, then clears it). "Change organization" also signs out first.
   - A 401 clears the token and returns to "connected, not signed in".
6. **Isolation.** If a table is added for tokens or device codes, it is global (not tenant-scoped), holds token hashes only (never the raw token), and `careeros_app` reaches it only through the plugin's own adapter calls or definer functions. Register it in the isolation registry.
7. **Tests.**
   - Unit: the scope allow-list, host binding, the sliding expiry, the extension's origin check before attaching the token.
   - Integration on an isolated database: a full device flow; approval on a different host fails; a token from org A used on org B's host, on the platform host and on a custom domain of org B is refused; a token cannot call a procedure outside the allow-list; revocation and member removal work; the token is stored hashed.
   - E2e: extend the P5-T01 extension spec to sign in through the device page and see "Signed in as".
8. Mark upstream edits `CAREEROS:` and list them. Add a CHANGELOG line. Update `apps/extension/README.md`. Log open points as questions and stop that part.

## Acceptance

- careeros-ci is fully green, including the isolation, inventory and skipped-suite guards.
- A clipper token cannot be used on any host of another org, or for anything outside its allow-list. Show both in tests.
- A member can see and revoke their clipper sign-ins on web and mobile.
