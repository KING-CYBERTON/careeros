# P2-Q01/Q02 review 1

**PR:** #59 · **Reviewer:** Opus · **Date:** 2026-11-02

## Checked

- **Q01.** A's session on B's host is refused with `ORG_HOST_NOT_MEMBER` for reads, writes and RPC, and the database is checked after each write attempt. A's API key gets 403 `ORG_HOST_KEY_MISMATCH` on B's host and 200 on A's. The browser lands on `/auth/organization-access`. Unknown org hosts return 404 with `noindex`.
- **Fuzz.** The org-host pass replays the whole inventory: 334 of 334 requests refused, zero leaks, and the platform pass is unchanged.
- **Registry.** The three tenant tables are registered, `auth_handoff` is allow-listed, the cleanup queue is global, and the pending list is empty.
- **Q02.** Every surface is checked per host, including raw-HTML isolation in both directions and `Vary: Host`.
- **Local runs:** the new specs, the handoff spec and both fuzz specs pass against a production build. The 7 other failures are the sandbox's missing ffmpeg, not this change. CI has not run because of the GitHub billing block.

## Answers

- **Q150:** accepted for Phase 2. Sender name and link host stay covered by `email-brand.test.ts` and `email-links.integration.test.ts`. Do not add a mail-capture hook to the production transport now.
- **Q151:** accepted as built. Without Cloudflare settings, any non-org host follows the platform rules by design (T03), and the test asserts the property that matters in both modes. Do not set placeholder `CF_*` values in CI.
- **Q152:** a real defect. Fix it in this PR. On an unknown or inactive org host, `hostMiddleware` must let the static web assets (`/assets/*`, icons, the manifest's static files) through, because they carry no org data, so the not-set-up page renders. Mark the edit `CAREEROS:` if the file is upstream. Add an e2e assertion that the not-set-up text is visible, and a unit test in the middleware suite.
- **Q153:** confirmed. API keys belong to the account, so deleting your own key from any host is intended. Leaving it out of the org-host pass is fine. Say why in a comment.
- **Q154:** no follow-up. T07's own e2e covers the settings UI.

## Verdict

Approved after the Q152 fix. Merge on fully green CI, e2e included, once Actions runs again.
