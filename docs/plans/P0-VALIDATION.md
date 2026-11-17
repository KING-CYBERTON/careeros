# PRODUCT.md validation (Opus, 2026-10-31)

Checked against the canonical Opus-Sonnet workflow and against upstream Reactive Resume v6.0.10 (commit `a69e483`).

## Result: OK to plan Phase 0. No blocking gaps.

| Check                                                               | Result   | Notes                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 present and matches canonical workflow                           | ✅       | Matches. Project-specific additions (tenant isolation = Critical, no Teal copying, keep MIT notices, Claude API only, §1.6 QA checklist) are additions, not edits.                                                    |
| No unfilled placeholders                                            | ⚠️ minor | §11 "$X / month" is an open pricing decision (§15 Q4). Not needed until Phase 3.                                                                                                                                      |
| Every P0 feature has acceptance criteria                            | ⚠️ minor | Present for §8.1, §8.2, §8.3, multi-tenancy (§6.3). Missing for §8.4 AI (only metering rules), §8.7 Admin consoles, §8.8 Billing, feature flags, branding, custom domains. → Q1; Opus writes them in each phase spec. |
| Roadmap has Phase 0 Setup and v1.0.0 gate with staging + production | ✅       | §13 / §13a.                                                                                                                                                                                                           |
| Open questions listed                                               | ✅       | §15 (7 items). Q1 (name/domain) and Q3 (hosting) block the staging environment → E2.                                                                                                                                  |

## Findings from inspecting upstream (affect later phases)

1. **Upstream already has several "to build" features.** v6.0.10 ships a career module with job discovery, an applications tracker with "Save job", custom domains via a Traefik HTTP provider (`CUSTOM_DOMAIN_TARGET`, `CUSTOM_DOMAIN_PROVIDER_SECRET`), scheduled career jobs (`apps/server/src/startup/career-scheduler.ts`), and an AI provider layer. Phases 2, 4 and 5 may shrink to "tenant-scope and extend". → Q2, Opus writes an upstream inventory before the Phase 1 plan.
2. **Better Auth 1.7.12 is present; the organization plugin is not used yet.** Phase 1 adds it.
3. **Server runs migrations on startup** (`apps/server/src/startup/checks.ts`) and supports `DATABASE_MIGRATION_URL`. Phase 1 must split roles: migrations as table owner, app as a non-superuser role so RLS applies.
4. **Upstream deploy targets are Vercel, Cloudflare Workers and Docker Hub**, plus an Expo mobile app (`apps/mobile`). CareerOS targets Docker on a VPS; mobile is a v1 non-goal. We keep those files untouched (merge-friendly) and leave them out of our CI and images.
5. **Upstream `docs/` is the public Mintlify site.** Our hand-off files share that folder per PRODUCT.md §1.4; they are new files, so upstream merges will not conflict.
6. **Upstream `AGENTS.md` (`CLAUDE.md` is a symlink to it)** tells agents to answer in "caveman" style and to keep plans in `.agents/docs/`. That conflicts with PRODUCT.md §1. P0-T02 adds a marked CareerOS block that takes precedence.
7. **Tooling:** lint/format is Vite+ (`vp lint`, Oxlint/Oxfmt), not ESLint; typecheck uses `tsrs` (Linux x64/arm64, macOS arm64 only). Tests: Vitest via Vite+, Playwright e2e in `tests/e2e`. Node 24, pnpm 12.
