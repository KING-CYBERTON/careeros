# P0-C02 — Review 1

**PR:** https://github.com/KING-CYBERTON/careeros/pull/6 · **Commit:** `3fd4085` · **Reviewer:** Opus (Thread 3) · **Date:** 2026-10-31

Checked against the spec: workflow_run gate (success + push + develop), exact `head_sha` checkout, amd64, gha cache, `APP_REVISION` build arg (same as upstream), tags `develop`/`sha-<sha>`/semver with no `latest`, OCI labels, provenance attestation, least-privilege permissions. The dispatch guard refuses refs other than develop or a tag. actionlint is clean.

## Findings

| Severity | File:Line                           | Issue                                                                 | Impact                                                                            | Fix instruction for Sonnet                       |
| -------- | ----------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| Medium   | repo settings                       | `workflow_run` is read from the default branch, which is still `main` | No automatic image after merges until the owner switches the default to `develop` | Owner action, already requested. No code change. |
| Low      | `careeros-image.yml` (semver regex) | Allows any pre-release suffix, not only `-rc.N`                       | Harmless; the release policy is enforced by Opus at tagging time                  | None.                                            |

## Test plan

Rows 1 and 3–7 run after merge, when Opus dispatches the workflow on `develop` and checks GHCR and the attestation. Row 2 is covered by the job `if`. A local docker build was not possible (no daemon in the sandbox).

## Verdict

**Approved, merge after green careeros-ci on the PR.**
