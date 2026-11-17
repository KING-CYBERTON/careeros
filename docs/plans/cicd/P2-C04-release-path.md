# P2-C04: Safe release tags, plus staging workflow fixes from the bring-up

**Status:** Approved (Opus, 2026-11-02). **Thread:** 3 CI/CD. **Origin:** Phase 0 to 2 exits (staging bring-up, 2026-11-02). **Branch:** `ci/P2-C04-release-path`. **Questions:** start at Q180.

## Problem

1. **Two publishers react to a `v*` tag.** CareerOS publishes images with `careeros-image.yml` (P0-C02). That workflow handles `v*` tags. The upstream `docker-publish.yml` is still active and also runs on `v*` tags and on pushes to `main`. It builds a second, differently built image into `ghcr.io/king-cyberton/careeros`, can overwrite tags such as `latest`, and has production steps: SSH redeploy, a Cloudflare purge and Docker Hub push to `amruthpillai/reactive-resume`. Those steps are skipped only because the secrets happen to be missing. The first release tag must not start it.
2. **The slug input trips the staging Cloudflare workflow.** `careeros-staging-cloudflare.yml` passes `inputs.slug` to every command. Commands that take no slug (`tunnel-ingress`, `fallback-origin`, `status`) then fail with "takes no slug" when the box was left filled in. This happened three times during the bring-up.
3. **The staging deploy is tight on a small server.** The deploy job's `timeout-minutes: 30` ran out while a home-lab server pulled a new image. The first pull of an image is the slow one.

## Requirements

1. **Switch off the upstream publisher in this repository.**
   - In `docker-publish.yml`, gate every job with `if: github.repository == 'amruthpillai/reactive-resume'`, or an equivalent single condition on the `plan` job that every other job depends on. Keep the file, so upstream merges stay easy. Mark the edit `# CAREEROS:` and list the file in `docs/UPSTREAM_PATCHES.md`.
   - Do the same for any other upstream workflow that triggers on `v*` tags or pushes to `main` and publishes or deploys. List what you found in the PR. Leave `careeros-*` workflows alone.
   - Add a check to the existing workflow self-test (or a new `node:test` file under `tooling/careeros/`) that parses each workflow and fails if a non-`careeros-*` workflow can run in this repository on a `v*` tag push without that guard.
2. **Release docs.** Add a short "Cutting a release" section to `infra/staging/README.md`, or a new `docs/RELEASING.md` linked from it. Cover these points:
   - Tags are `vMAJOR.MINOR.PATCH`, annotated, and set on the `develop` commit that passed CI.
   - Pushing the tag runs `careeros-image.yml`, which publishes `ghcr.io/king-cyberton/careeros:<version>`.
   - Promotion to `main` and production is Phase 4 and is not part of this spec.
3. **Slug only where it belongs.** In `careeros-staging-cloudflare.yml`, pass the slug to the script only for `org-dns` and `org-dns-remove`. For the other commands, print a notice that the slug was ignored. Update the input description to match.
4. **Deploy time limit.** Raise the deploy job's `timeout-minutes` to 60. Add a runbook line: on a slow connection, pre-pull the image once as `deploy` with `docker pull ghcr.io/king-cyberton/careeros:sha-<sha>`, then re-run the workflow.
5. **Docs.** A line in `CHANGELOG-CAREEROS.md`.

## Out of scope

- The 25 MB smoke upload and memory use on small servers. Stephen added swap, so this is recorded only as a backlog item.
- Any change to `careeros-image.yml` beyond what requirement 1 needs.

## Acceptance

- After the change, a `v*` tag push in this repository starts `careeros-image` and no upstream publish or deploy job. Show this with the new self-test and by reading the `if:` conditions in the PR.
- The Cloudflare workflow accepts a filled slug box with `tunnel-ingress` and runs it.
- CI is fully green. Lint and format are clean. Every edit to an upstream file is marked `CAREEROS:` and listed.
- No Co-Authored-By trailers and no AI attribution in commits.
