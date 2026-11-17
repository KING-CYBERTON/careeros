# P2-T08 review 1

**Reviewer:** Opus, 2026-11-01. **PR:** [#47](https://github.com/KING-CYBERTON/careeros/pull/47). **Verdict:** Approved after the follow-up commit `424fdc970`. Merge on fully green CI.

## Checked

- `LICENSE` and `NOTICE` are untouched. The `/licenses` page and the mobile "Product" tab render the `NOTICE` text, and a unit test pins it to the file, so the upstream copyright line stays verbatim.
- There is one brand source: `@reactive-resume/utils/brand`, which is universal and has no runtime dependencies. `getBrand()` reads `globalThis.__BRAND__`, ready for T02.
- Auth `appName` and the two-factor issuer use the platform default.
- The upstream homepage, donation toast, GitHub stars button, OlaCV affiliate promo and the agent-skills well-known routes are removed. The plugin directory stays in the tree for upstream sync.
- Mobile store and native items are unchanged. They are recorded as a **release blocker** in `.agents/docs/mobile-release-handoff.md`: the binary must not ship pointing at upstream hosts.

## Answers (Q80–Q85, given in the review thread)

- **Q80:** native hosts wait for §15.1. This is a release blocker.
- **Q81:** remove the OlaCV promo.
- **Q82:** stop serving the agent skills. Rewriting them is Phase 6 work.
- **Q83:** the judgement calls are accepted. The spec generator defaults to `https://careeros.example`.
- **Q84:** the new handoff file is fine.
- **Q85:** the translation pass is Phase 6.

## Follow-ups

- P2-C02 adds the CI grep gate, using the command in the PR body.
- `static/agent-skills.ts` and the star-count endpoint are now unused. A knip cleanup can remove them later.
