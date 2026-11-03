# P6-T01 review 1

**Reviewer:** Opus, 2026-11-02. **PR:** [#73](https://github.com/KING-CYBERTON/careeros/pull/73). **Verdict:** Approved. Merge on fully green CI, e2e included. The drafts are not in force until Stephen approves them.

## Checked

- `docs/legal/terms.md`, `privacy.md` and `dpa.md` carry the draft banner, are written in plain language, and mark every unknown `[TO CONFIRM]`. The DPA states that CareerOS holds no security certification. The privacy draft lists the job discovery data and the public job boards, which receive no member data.
- `/terms`, `/privacy` and `/dpa` render the bundled Markdown with the banner while `LEGAL_PAGES_APPROVED` is false. The server serves them as the app shell with `noindex` instead of a 404, and the names are reserved as usernames.
- `resolveLegalLinks` uses the org's own legal links when set (P2-T01 still wins) and the platform pages otherwise, on web and mobile.
- The `Dockerfile` copies `docs/legal` from the pruner stage, which has the whole checkout (`.dockerignore` does not exclude `docs/`). The next staging deploy proves the image build.
- `/licenses` and the MIT notice are untouched.

## Answers (Q280–Q292)

- **Q280:** the production AI provider is the Claude API (project rule). Keep the retention and training wording `[TO CONFIRM]` until Stephen checks Anthropic's current commercial terms.
- **Q281:** accepted. Describe the cookies the code actually sets.
- **Q282:** accepted. At approval, a follow-up flips the constant, makes the pages indexable and adds them to the sitemap.
- **Q283:** accepted.
- **Q284, Q285, Q286:** these are Stephen's (or a lawyer's) to fill; listed in STATUS.
- **Q287:** accepted.
- **Q288:** accepted. The open-source notice is a licence duty.
- **Q289:** Opus added the STATUS line.
- **Q290:** accepted for now. P3-T08 does not expose member content to org admins; re-read the drafts when it merges.
- **Q291:** accepted.
- **Q292:** accepted. Re-read the drafts against the released features before approval.
