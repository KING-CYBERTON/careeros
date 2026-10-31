# P0-T03 — Local baseline run

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 1 Build · **Depends on:** P0-T01 · **Test plan:** [../test-plans/P0-T03.md](../test-plans/P0-T03.md)

## Goal
Prove the unmodified upstream app installs, builds, migrates and passes its own tests in our environment, and record the numbers we will compare against in every later phase.

## Steps
Follow upstream `AGENTS.md` "Setup" and `tests/e2e/README.md` exactly, using a Linux x64 environment with Docker:
1. `pnpm install --frozen-lockfile`; start `postgres redis seaweedfs seaweedfs_create_bucket` from `compose.dev.yml`.
2. Use generated local secrets (never commit them).
3. Run and time: `pnpm lint`, `pnpm format:check`, `pnpm exec turbo boundaries`, `pnpm typecheck`, `pnpm db:migrate`, `pnpm test:ci` (with the same env vars upstream CI uses in `.github/workflows/ci.yml` job `test`), `pnpm build`, `pnpm test:e2e --workers=1`.
4. Start the production server (`pnpm start`) and confirm `GET /api/health` returns 200.
5. Write `docs/BASELINE.md` with a table: command · result (pass/fail + counts of tests passed/failed/skipped) · duration · notes. Add the Node, pnpm and Docker versions used and the upstream commit.

## Out of scope
Fixing any upstream failure. If any command fails, record the failure output summary in BASELINE.md, log a question in `docs/questions.md`, and still open the PR.

## Acceptance criteria
- `docs/BASELINE.md` exists with every command above and real numbers.
- No other files changed.
- PR `[P0-T03] Local baseline` targets `develop`.
