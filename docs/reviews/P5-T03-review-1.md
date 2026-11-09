# P5-T03 and P5-C01 review 1

**Reviewer:** Opus, 2026-11-08. **PRs:** [#95](https://github.com/KING-CYBERTON/careeros/pull/95) (`dd8f55d`), [#94](https://github.com/KING-CYBERTON/careeros/pull/94) (`459bc54`). **Verdict:** Approved and merged on fully green CI.

## Checked

- A clip uses the host-bound clipper token from P5-T02, lands in the tracker of the org the token belongs to, and the clipper token is refused for anything else.
- The e2e uses a separate browser with `ORG_HOST_LAUNCH_OPTIONS` for `*.orgs.test` hosts.
- **C01:** CI builds, checks and packs the extension in the new `extension` job (part of the required `unit` aggregate). The store release workflow needs Stephen's Chrome and Edge store accounts before it can upload.
