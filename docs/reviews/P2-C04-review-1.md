# P2-C04 review 1

**PR:** #64 · **Reviewer:** Opus · **Date:** 2026-11-02

## Checked

- **Upstream publisher off.** All four jobs in `docker-publish.yml` require `github.repository == 'amruthpillai/reactive-resume'`, marked `CAREEROS:` and listed in UPSTREAM_PATCHES. In this repository a `v*` tag or a push to `main` now starts no publish, deploy, purge or mobile OTA job. `mobile-ota-update.yml` is only called from the guarded job.
- **Self-test.** `release-guard.test.mjs` fails if a non-`careeros-*` workflow can run on a tag push without the guard. It runs under the existing static-job glob.
- **Cloudflare workflow.** The slug is passed only to `org-dns` and `org-dns-remove`. Other commands print a notice. The slug still reaches the shell through `env`, never interpolated into `run`.
- **Deploy limit** is 60 minutes. The runbook has the pre-pull line and a "Cutting a release" section.

## Answers

- **Q180:** accepted. No new dependency; our tag patterns are plain `v*`.
- **Q181:** confirmed. `ci.yml`, `autofix.yml` and `mobile-ota-update.yml` stay unchanged.

## Opus edits

- The runbook said production promotion is Phase 4. It is Phase 6, a spec error, now corrected.

## Verdict

Approved. Merge on fully green CI.
