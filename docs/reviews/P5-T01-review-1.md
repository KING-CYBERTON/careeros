# P5-T01 review 1

**Reviewer:** Opus, 2026-11-02. **PR:** [#66](https://github.com/KING-CYBERTON/careeros/pull/66). **Verdict:** Approved after the follow-up commits `d750d6a` and `b15d516`. Merge on fully green CI, e2e included.

## Checked

- The manifest asks only for `activeTab`, `storage` and `scripting`, with `optional_host_permissions: ["https://*/*"]` and no install-time host permissions. A test pins the built manifest.
- The org origin permission is requested only after the user confirms the org (Q236), and stray origins are released.
- The extension page CSP has no remote scripts and no `unsafe-eval`. The `app:extension` boundary rule keeps server packages out.
- The server CORS change (`apps/server/src/http/extension-cors.ts`) applies only to `GET /api/openapi/branding/host`, echoes only `chrome-extension://` and `moz-extension://` origins, sets `Vary: Origin` and never allows credentials. Every other route is unchanged.
- Everything from the server is treated as data: text is escaped, and the logo loads only from the entered origin.

## The e2e logo failure

The branding service builds logo addresses from `APP_URL`, so on an org host the logo address points at the platform origin and the popup's same-origin rule dropped it. The fix (`apps/extension/src/lib/branding.ts`) keeps addresses on the entered origin as they are, rebuilds only a path that matches the branding-asset pattern on the entered origin (the same rule the mobile app uses), and still refuses any other cross-origin address. The entered origin must itself be https, or a development http host. This is narrow and safe. The e2e assertion is unchanged.

## Answers (Q230–Q239)

All accepted as logged in the PR. Q236 changed the code as above.

## Follow-ups

- Backlog: the branding API could return logo addresses on the request's own org host instead of `APP_URL`, which would remove the rebuild in the extension and the mobile app.
- P5-T02 (sign-in) and P5-C01 (CI zip and store steps) can start.
