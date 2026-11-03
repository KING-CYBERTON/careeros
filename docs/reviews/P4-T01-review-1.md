# P4-T01 review 1

**Reviewer:** Opus, 2026-11-02. **PR:** [#68](https://github.com/KING-CYBERTON/careeros/pull/68). **Verdict:** Approved after the follow-up commit `f82b496` and the develop merge `758117d`. Merge on fully green CI, e2e included.

## Checked

- **SSRF (G1).** A board is `{ source, token }`, never a URL. The token is validated in Zod, again when a stored row runs, and by a CHECK on the list length. The fetch URL is a fixed host plus `encodeURIComponent(token)`. The transport is the repo's `fetchPublic`, which refuses private, loopback, link-local and mapped addresses at socket open. Redirects are followed by hand, at most 2, each hop https, default port, no credentials, host on the four-host allow-list. 15 s deadline across headers and body, 5 MB cap while reading, JSON content type required. Errors store a code and a fixed reason, never a response body.
- **Untrusted text (G4).** Descriptions go through `sanitize-html` with a strict allow-list; titles and companies are plain text capped at 300 characters; URLs must be https.
- **Data (G2).** Three tenant tables with ENABLE and FORCE RLS, composite tenant foreign keys, `SET NULL (column)` so the tenant column is never cleared, the unique key that keeps a dismissed job from coming back, and all three in the isolation registry. The migration was regenerated so its snapshot parent is the P3-T01 snapshot.
- **Plan gate.** Every discovery procedure now checks `getEntitlements(...).features.job_discovery` and refuses with `FEATURE_NOT_IN_PLAN`. Tests cover a plan without the feature, a plan with it, and an org flag that turns it off.
- **Limits.** At most 20 automations per user per org, enforced under an advisory lock (25 parallel creates leave exactly 20). `runNow` is limited to once per source per 10 minutes by one conditional update.

## Answers (Q220–Q229)

- **Q220:** accepted. P4-Q01 rechecks the Greenhouse and Ashby shapes when their docs can be reached.
- **Q221:** the gate must not be open. Now checks `getEntitlements`; `requireFeature` replaces it in P3-T02.
- **Q222:** `role:api` accepted.
- **Q223:** accepted.
- **Q224:** accepted for T01. P4-T02 separates scheduled runs from the manual limit and makes `runNow` return early.
- **Q225:** confirmed. P4-T02 owns the definer function for due sources and `next_run_at`.
- **Q226:** discovery is for signed-in members. P4-T02 adds the guest move and the account export.
- **Q227:** accepted (P4-T02 lets a dismissed job be accepted).
- **Q228:** cap of 20 automations per user per org, added.
- **Q229:** accepted.

## Follow-ups

- P4-T02 (scheduler, AI match, review queue, accept) can start once P3-T03 merges.
