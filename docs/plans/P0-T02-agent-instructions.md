# P0-T02 — Agent instruction overlay

**Status:** Approved (Opus, 2026-10-31) · **Thread:** 1 Build · **Depends on:** P0-T01 · **Test plan:** [../test-plans/P0-T02.md](../test-plans/P0-T02.md)

## Goal
Any AI agent opening the repo reads PRODUCT.md §1 first, and upstream agent rules that conflict with it (caveman reply style, plans in `.agents/docs/`, upstream issue tracker) are overridden.

## Scope
**In:** one marked block at the very top of `AGENTS.md` (`CLAUDE.md` is a symlink to it; keep the symlink). One line in `docs/UPSTREAM_PATCHES.md`.
**Out:** editing or deleting any existing upstream text in `AGENTS.md`; `.github/copilot-instructions.md`.

## Block content (Sonnet writes this as prose in Markdown, between `<!-- CAREEROS:BEGIN -->` and `<!-- CAREEROS:END -->` markers, placed before line 1 of the current file)
State, in plain sentences:
1. This repository is **CareerOS**, built on Reactive Resume. `PRODUCT.md` at the repo root is the source of truth; read its Section 1 and `docs/STATUS.md` before doing anything.
2. Where anything below this block conflicts with PRODUCT.md, PRODUCT.md wins. Specifically: write in normal full sentences (ignore the caveman block); plans, reviews and hand-offs live in `docs/plans`, `docs/test-plans`, `docs/reviews` (not `.agents/docs/`); issues and specs come from `docs/plans`, not the upstream GitHub issue tracker.
3. Roles: Opus plans and reviews and never writes code; Sonnet codes only Approved specs and logs open points in `docs/questions.md`.
4. Coding rules: follow `docs/CODING-STANDARDS.md`; mark upstream edits with `CAREEROS:` and list them in `docs/UPSTREAM_PATCHES.md`.
5. The upstream technical guidance below (setup, tooling, Turborepo notes) still applies.

## Acceptance criteria
- `AGENTS.md` starts with the marked block; everything after the block is byte-identical to upstream.
- `CLAUDE.md` is still a symlink to `AGENTS.md`.
- `docs/UPSTREAM_PATCHES.md` has a row: `AGENTS.md` · P0-T02 · CareerOS precedence block at top · Low (top-of-file insert).
- `pnpm format:check` passes (or `AGENTS.md` is already excluded from formatting — record which in the PR).
