# P2-T07 review 1

**PR:** #56 · **Reviewer:** Opus · **Date:** 2026-11-02

## Checked

- **Authorization.** Every new write (`deleteLogo`, `deleteFavicon`) and the new `organization/domains/info` read call `requireOrganizationAdmin`. No input carries an organization id. The UI role gating is cosmetic, and the API decides.
- **Delete.** The key is nulled and cleanup enqueued in one transaction under `FOR UPDATE`, then the cache is busted. A best-effort immediate cleanup follows, and the queue covers its failure.
- **`GET /branding/host`.** The org comes only from the resolved `HostContext`. Any non-org host gets the all-null default. The output schema has no sender name or reply-to, and tests assert this on org A, org B, the platform and an unknown host. Rate limited like the other public reads.
- **`domains/info`.** Builds the subdomain from `ORG_HOST_PATTERN` and the org's own slug. It exposes nothing beyond what the admin can already see.
- **Parity and OTA.** Mobile screens use the same API. The fingerprint is unchanged (`5899fe13…`), so this ships as an OTA update.
- **Tests:** run with a database, 0 skipped. The e2e spec is new and runs for the first time in CI.

## Answers

- **Q130:** accepted. Mobile join is deferred to Phase 3, because allowing bearer tokens on `organizationHost.join` would let any OAuth client holding a user token join that user to an open-signup org. It needs a first-party-client check first. The mobile blocked sheet stays as it is. This is recorded as a Phase 2 exit note.
- **Q131:** this was a spec error. Change the warning to measure the primary colour against the page background: warn when `contrastRatio(primary, "#ffffff")` is below 3:1 (WCAG AA for large text and UI components), with the text "This colour may be hard to see on a white background." Share the rule in `@reactive-resume/utils/brand-form` so web and mobile use it, and update the test so it no longer forces a value.
- **Q132:** accepted.
- **Q133:** accepted. The API stays the guard.
- **Q134:** accepted.
- **Q135:** accepted. Q02 covers the domain-records step once staging has Cloudflare.
- **Q136:** accepted. The Q122 wording is more accurate.
- **Q137:** accepted.
- **Q138:** accepted. A Settings guide becomes a docs task when §15.1 fixes the product name.

## Verdict

Approved after the Q131 change and a merge of develop. Merge on fully green CI, e2e included.
