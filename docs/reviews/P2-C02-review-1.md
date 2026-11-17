# P2-C02 review 1

**PR:** #55 · **Reviewer:** Opus · **Date:** 2026-11-02

## Checked

- **Gate:** plain Node with no dependencies. It reports `file:line`, excludes import specifiers, docs, tests and `NOTICE`, and allows the licenses page by path only while it still carries the attribution, so a removal there cannot hide behind the allowance.
- **Allowances:** 16, each with a reason. 8 are the native identity, the Q80 release blocker. The other 8 are internal names, such as importer identifiers for the upstream file format and local variables, none of them user-visible.
- **CI:** the gate and the mobile node tests now run in `static`, which closes the gap that hid the P2-T03 mobile test regression.
- **Self-test:** 11 cases.

## Answers

- **Q140:** confirmed. Comment-only lines in code files are not user-visible, so skipping them is right. Trailing comments on code lines still count.
- **Q141:** all 16 allowances are accepted, and a whole-file scan of `app.config.ts` is fine. `.agents/` is gitignored, so the native-identity release blocker is now recorded in the tracked `docs/STATUS.md` watch list instead. The 8 native-identity allowances must be removed when the native identity (Q80) is set; the gate will then keep them out.

## Verdict

Approved, to merge on fully green CI.
