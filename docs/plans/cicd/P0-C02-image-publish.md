# P0-C02 — Build and publish image to GHCR

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 3 CI/CD · **Depends on:** P0-C01 · **Test plan:** [../../test-plans/P0-C02.md](../../test-plans/P0-C02.md)

## File: `.github/workflows/careeros-image.yml`
- Triggers: `workflow_run` of `careeros-ci` with `types: [completed]` on branch `develop` (run only if `conclusion == success` and the event was `push`); `push` of tags `v*`; `workflow_dispatch`.
- Check out the exact `head_sha` of the triggering run (not the branch tip).
- Permissions: `contents: read`, `packages: write`, `id-token: write`, `attestations: write`.
- Build with Docker Buildx from the upstream root `Dockerfile`, platform `linux/amd64`, GitHub Actions cache (`type=gha`). Build arg / label: pass the commit SHA so `/api/health` reports it (check how upstream `docker-publish.yml` passes `APP_REVISION` and do the same).
- Image name: `ghcr.io/${{ github.repository }}` lower-cased.
- Tags: on develop → `develop`, `sha-<full sha>`; on tag `vX.Y.Z[-rc.N]` → `X.Y.Z[-rc.N]` and `sha-<sha>`. Never tag `latest` in Phase 0.
- OCI labels: source, revision, version, `org.opencontainers.image.licenses=MIT`.
- Generate build provenance attestation (`actions/attest-build-provenance`).
- Package visibility stays private (inherits repo).

## Acceptance criteria
- After a merge to `develop`, `ghcr.io/<owner>/<repo>:sha-<sha>` and `:develop` exist.
- `docker run` of that image with a disposable Postgres returns 200 on `/api/health` and the response contains the same SHA.
- Failed CI on develop produces no image.
