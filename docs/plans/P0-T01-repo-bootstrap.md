# P0-T01 — Repo bootstrap

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 1 Build · **Depends on:** E1 (repo name from Stephen) · **Test plan:** [../test-plans/P0-T01.md](../test-plans/P0-T01.md)

## Goal
The private CareerOS repo contains the full upstream history at the pinned commit, CareerOS governance files, and the `develop` branch as default.

## Scope
**In:** importing history, remotes, branches, root governance files, the `docs/` hand-off files written by Opus.
**Out:** any change to upstream code, workflows, package names or README.

## Steps
1. Clone upstream `https://github.com/reactive-resume/reactive-resume` (full history, not shallow). Check out commit `a69e48318aab3c1c3ea57d2c0467710ef0d8342f`.
2. Add the private repo as `origin`; rename the upstream remote to `upstream`. Push that commit as `main` to `origin`. Do **not** push upstream tags or other upstream branches.
3. Create `develop` from `main`, push it, and set `develop` as the repository default branch.
4. Create `upstream-sync` from `main` and push it (used for monthly merges, §12).
5. On a branch `feature/P0-T01-bootstrap` from `develop`, add these files exactly as provided by Opus in the project folder `careeros/` (copy verbatim, no edits):
   - `PRODUCT.md` (repo root)
   - `NOTICE` (repo root). Leave the upstream `LICENSE` untouched.
   - `docs/STATUS.md`, `docs/questions.md`, `docs/ESCALATIONS.md`, `docs/RELEASE-1.0.0.md`, `docs/UPSTREAM_PATCHES.md`, `docs/CODING-STANDARDS.md`, `docs/THREAD-PROMPTS.md`
   - `docs/plans/**`, `docs/test-plans/**`, `docs/reviews/README.md`
6. Add `CHANGELOG-CAREEROS.md` at the root with a `## Unreleased` heading and one line: "Phase 0 setup started from Reactive Resume v6.0.10 (a69e483)".
7. Open a PR to `develop` titled `[P0-T01] Repo bootstrap`.

## Acceptance criteria
- `git log origin/main -1` is `a69e483…`; `git remote -v` shows `origin` (private repo) and `upstream` (reactive-resume).
- `develop` is the default branch; `main`, `develop`, `upstream-sync` exist.
- All listed files are present and byte-identical to the Opus copies; `LICENSE` is unchanged vs upstream.
- No file outside the list above changed (`git diff --stat develop...feature/P0-T01-bootstrap` shows only these new files).

## Risks
- Pushing upstream tags would clutter release tagging → do not push tags.
- Repo created with a README/license would make the first push non-fast-forward → if so, log a question; do not force-push without Opus.
