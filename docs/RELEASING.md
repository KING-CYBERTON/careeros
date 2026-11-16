# Releasing CareerOS (P6-C01)

Releases go from `develop` to `main` to production. The full runbook, with the deploy steps and rollback, is [infra/production/README.md](../infra/production/README.md).

1. **Candidate.** Opus opens a PR from `develop` to `main` for the candidate commit. CI must pass before the merge.
2. **Tag.** After the merge, set an annotated tag `vX.Y.Z` (or `vX.Y.Z-rc.N` for a pre-release) on that `main` commit and push it. The tag push runs `careeros-image`, which publishes `ghcr.io/king-cyberton/careeros:X.Y.Z`.
3. **Pre-releases first.** An `-rc.N` tag is tried on staging before the final tag goes to production.
4. **Deploy.** Run **Actions -> careeros-deploy-production** with `action` = `deploy` and the tag. The workflow refuses a tag whose commit is not on `main`, refuses a server `.env` with test keys or unsafe flags, checks `/api/health` reports the tag's commit, and rolls back to the last verified version if a check fails.

## Migrations must not break the previous release

A rollback puts back the old app image but keeps the new schema. Every migration must therefore work with the previous release's code: add first, remove or rename only in a later release (expand, then contract). A release that cannot meet this says so in its PR, and its rollback is a database restore (P6-C02) instead of `rollback.sh`.
