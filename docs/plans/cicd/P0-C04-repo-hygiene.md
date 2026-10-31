# P0-C04 — Branch protection, dependency and secret hygiene

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 3 CI/CD · **Depends on:** P0-C01 · **Test plan:** [../../test-plans/P0-C04.md](../../test-plans/P0-C04.md)

## Files
- `.github/dependabot.yml`: ecosystems `npm` (root, weekly, target `develop`, group minor+patch into one PR, max 5 open), `github-actions` (weekly, target `develop`), `docker` (root `Dockerfile`, monthly). Commit message prefix `chore(deps)` (commitlint-compatible).
- `.github/workflows/careeros-licenses.yml`: on push to `develop` and weekly: install, produce a production dependency license report (`pnpm licenses list --prod --json`), upload as artifact, and fail if any license in a deny list appears: `GPL-2.0`, `GPL-3.0`, `AGPL-3.0`, `SSPL-1.0` (exact SPDX ids, also `-only`/`-or-later` variants). If upstream already includes such a dependency, do not fail the job — print it and log a question for Opus.
- `.github/CODEOWNERS`: `docs/plans/ docs/test-plans/ docs/reviews/ docs/STATUS.md docs/ESCALATIONS.md docs/RELEASE-1.0.0.md PRODUCT.md` → `@<repo owner>` (protects Opus-owned files from accidental edits).

## Settings (via `gh api` if permitted, else listed in the PR for Stephen/Opus)
- Branch protection on `develop` and `main`: require PR, require status checks `careeros-ci / static`, `careeros-ci / unit`, `careeros-ci / e2e`; require branch up to date; no force-push; no deletion. `main` additionally: restrict pushes to admins (release merges only).
- Enable secret scanning and push protection (if available for the plan; if not, note it in the PR and Opus logs it).
- Enable Dependabot alerts.

## Acceptance criteria
- A test PR that fails lint cannot be merged into `develop`.
- `dependabot.yml` validates (Dependabot shows it in Insights → Dependency graph → Dependabot without errors).
- License job runs green and uploads the report.
