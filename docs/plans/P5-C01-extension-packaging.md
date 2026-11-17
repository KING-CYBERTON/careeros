# P5-C01: Job Clipper build, zip and version in CI; store submission runbook

**Status:** Approved (Opus, 2026-11-08). **Thread:** 3 CI/CD. **Plan:** GTM-PLAN.md (P5-C01, G5). **Depends on:** P5-T01 merged. Coordinate with P5-T03 (in build) only through the shared `apps/extension/package.json` version field.
**Branch:** `ci/P5-C01-extension-packaging`. **Questions:** start at Q400.

## Goal

Every CI run builds the clipper and proves it packs. A tagged release produces a store-ready zip for Chrome and Edge as a workflow artifact, and the runbook says exactly how a person submits it.

## Requirements

1. **CI job** in `.github/workflows/careeros-ci.yml`, named `extension`, running on PRs and pushes that touch `apps/extension/**`, the packages it imports, the workflow itself, or the lockfile. Use the `changes` job's path filter the way the other careeros-ci jobs do. It runs `pnpm --filter <extension package> run pack` and uploads the zip as an artifact kept 14 days.
2. **Pack checks** (in `scripts/pack.mjs` or a test beside it):
   - The zip holds `manifest.json` at the root, and no source maps, `.env*` files, `node_modules` or test files.
   - The manifest permissions equal the manifest test's expected set exactly.
   - `manifest.version` equals `apps/extension/package.json` version, in Chrome's dotted-number format.
   - The zip is at most 10 MB.
   - The zip contains no product branding strings (reuse the existing branding gate's word list).
3. **Release artifact:** a workflow `careeros-extension-release.yml`, run by hand (`workflow_dispatch`) or on a tag named `clipper-v*`, builds the zip named `job-clipper-<version>.zip`, attaches a SHA-256 checksum file, and uploads both as artifacts kept 90 days. It needs no store credentials and does not upload to any store.
4. **Required check:** make `extension` a job the existing required `static` or `unit` gate depends on, or tell Opus in a question if the required-checks list has to change in repo settings (Stephen does that).
5. **Runbook** `docs/runbooks/job-clipper-release.md`:
   - Bumping the version.
   - Running the release workflow and downloading the zip.
   - Chrome Web Store steps: developer account, a new item, uploading the zip, the privacy practices form (single purpose; the `activeTab`, `scripting` and `storage` justifications; data handling consistent with the privacy policy), screenshots, and review.
   - Edge Add-ons steps in Microsoft Partner Center, the same way.
   - Rolling back to a previous version.
   - Placeholders only: no account ids or secrets.
6. Add a CHANGELOG line and update `apps/extension/README.md`.

## Tests

- The pack checks fail on a deliberately bad fixture: a zip with a source map, an extra permission, or a version mismatch.
- CI shows the `extension` job green on this PR.

## Acceptance

- careeros-ci is fully green.
- A person can follow the runbook from a release artifact to a store submission without asking questions.
