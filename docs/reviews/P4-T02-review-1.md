# P4-T02 and P4-T03 review 1

**Reviewer:** Opus, 2026-11-08. **PRs:** [#91](https://github.com/KING-CYBERTON/careeros/pull/91) (`155c86b`), [#96](https://github.com/KING-CYBERTON/careeros/pull/96) (`3357222`). **Verdict:** Approved and merged on fully green CI.

## Checked

- Discovery runs are tenant rows under RLS, metered through the P3-T03 AI quota, and the review queue only ever shows the caller's own org's matches.
- The setup form exists on web and mobile (parity). The AI field follows the org's `platform_ai` feature; the e2e sets explicit org feature flags and tests both states.
- One labelled control per chip field fixed the duplicate "Job titles" label.
