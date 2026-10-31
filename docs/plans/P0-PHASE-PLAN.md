# Phase 0 — Setup: Phase Plan

**Status:** Approved (Opus, 2026-10-31) · **Target:** 1 week of work once E1 and E2 are answered · **Exit tag:** `0.0.1`

## Goal
A private CareerOS repository based on Reactive Resume v6.0.10 with the hand-off structure in place, CI green on `develop`, the unmodified upstream app running on a staging server from a GHCR image, a test harness that includes a working tenant-isolation framework, and all three threads having completed one task through the PRODUCT.md §1.3 loop.

## Out of scope
Any product change: no tenancy tables, no branding, no renaming of upstream UI. No production environment (Phase 6). No upstream feature removal.

## Key decisions (Opus)
| # | Decision | Reason |
|---|---|---|
| D1 | Private repo; upstream history imported, `upstream` remote kept (E1 answered by Stephen) | Commercial code private; monthly merges still possible |
| D2 | Branches: `main` (production, tags only), `develop` (default, staging), `feature/*`, `upstream-sync` | PRODUCT.md §13a |
| D3 | New code under `@careeros/*` packages; upstream names untouched | Merge friendliness (§12) |
| D4 | Upstream workflows are kept as files but **disabled in GitHub Actions settings**; CareerOS adds its own `careeros-*.yml` workflows | Zero edits to upstream workflow files; an upstream test reads `docker-publish.yml` |
| D5 | CI and image exclude `apps/mobile`, Vercel and Cloudflare checks | Non-goals for v1; saves CI minutes (E3) |
| D6 | Image: upstream `Dockerfile` unchanged, `linux/amd64` only, pushed to `ghcr.io/<owner>/<repo>` | Smallest change; one VPS architecture |
| D7 | Staging: Docker Compose on one VPS (Postgres, Redis, SeaweedFS, app, Caddy for TLS), deployed by GitHub Actions over SSH on every green `develop` image | PRODUCT.md §10 pilot stage |
| D8 | Isolation tests always run as a **non-superuser** Postgres role | Superusers and table owners bypass RLS; a harness that runs as `postgres` proves nothing |
| D9 | Hand-off files live in `docs/` exactly as PRODUCT.md §1.4 says, alongside upstream's public docs | PRODUCT.md is the source of truth |

## Tasks and order

| Order | ID | Thread | Title | Depends on |
|---|---|---|---|---|
| 1 | P0-T01 | 1 Build | Repo bootstrap (import, branches, NOTICE, PRODUCT.md, docs/) | E1 repo name |
| 2 | P0-T02 | 1 Build | Agent instruction overlay in AGENTS.md | T01 |
| 2 | P0-T03 | 1 Build | Local baseline run and `docs/BASELINE.md` | T01 |
| 2 | P0-Q01 | 2 QA | Test harness conventions + CareerOS test scaffolding | T01 |
| 2 | P0-C01 | 3 CI/CD | CareerOS CI workflow | T01 |
| 3 | P0-Q02 | 2 QA | Tenant isolation test framework (`@careeros/isolation-testing`) | Q01, C01 |
| 3 | P0-C02 | 3 CI/CD | Build and publish image to GHCR | C01 |
| 3 | P0-C04 | 3 CI/CD | Branch protection, Dependabot, secret scanning, license report | C01 |
| 4 | P0-C03 | 3 CI/CD | Staging environment and auto-deploy | C02, E2 |

Thread operational = the thread has one task merged through spec → code → review → fix → merge. Thread 1: T01. Thread 2: Q01. Thread 3: C01.

## Phase exit checklist (Opus verifies, then tags `0.0.1` on `develop` → `main`)
1. All nine tasks merged, reviews in `docs/reviews/` with no open Critical/High.
2. `careeros-ci` green on the `develop` head commit.
3. Staging URL serves the upstream app over HTTPS; `/api/health` returns 200 with the deployed commit SHA; staging smoke (P0-C03) passes.
4. Isolation framework self-tests pass in CI, including the deliberate-leak negative test.
5. `docs/STATUS.md` updated; Phase 1 plan started.

## Risks
| Risk | Mitigation |
|---|---|
| Upstream e2e suite is slow/flaky on 2-vCPU GitHub runners | Run e2e with 1 worker; record baseline time in T03; if > 25 min, Opus re-plans sharding |
| `tsrs` typecheck binary unsupported on some dev machines | CI is Linux x64; documented in BASELINE.md |
| Private-repo Actions minutes (E3) | e2e only on PRs and `develop`; concurrency cancel on PRs |
| Upstream server auto-migrates on boot | Fine for Phase 0; Phase 1 splits migration vs app roles |
| Staging host not chosen (E2) | C03 is last in order; everything else proceeds |
