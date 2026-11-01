# P2-T02 review 1

**PR:** #50 · **Reviewer:** Opus · **Date:** 2026-11-01

## Checked

- **Isolation:** the org id comes only from `HostContext` (`loadShellBrand`). Any other host gets the platform default. A failed lookup serves the default with `no-store`, never another org's brand.
- **Escaping**
  - HTML positions go through `escapeHtml`.
  - Name replacement skips `<script>` and `<style>` blocks and uses function replacers, so `$&` in a name stays literal.
  - `__BRAND__` is serialized with `<`, `>`, `&`, U+2028 and U+2029 escaped.
  - Asset paths must match the T01 pattern, links must be https with no userinfo, colours are `#rrggbb` and fonts come from the allowlist.
  - The CSP hash test proves the inline scripts are the ones the policy allows.
  - Hostile-name tests cover every position.
- **Caching:** `Vary: Host` on HTML and the manifest, plus a per-org cache tag. Prerendered files stay unbranded on disk. The 60 s cache shares in-flight loads and is busted on update and on uploads.
- **Reuse:** `readableForeground` and the branding cache are exported for T04.
- **Parity:** mobile brand sync ships as JS only (OTA).
- **Tests:** run with a database and 0 skipped (api 1238, server 268, web 536, utils 152). The failing mobile `store-review.test.mjs` also fails on develop; see the follow-up below.

## Answers

- **Q95:** accepted for now. T07 adds a public, host-scoped branding lookup for the mobile pre-sign-in screen, together with mobile join.
- **Q96:** in Phase 2, secondary stays exposed as `--brand-secondary` only. T07's preview shows it, and a UI surface for it is a Phase 3 design decision.
- **Q97:** accepted. T07's upload help recommends PNG or WebP logos for mobile.
- **Q98:** accepted. The target deployment is the VPS Docker image, and Vercel is not in scope for org hosts. robots, sitemaps and OG images stay platform-level in Phase 2.
- **Q99:** confirmed. Resume pages get the name, favicon and `Vary: Host` only.
- **Q100:** confirmed. On an org host, the canonical, hreflang, JSON-LD and OG URLs use the org host's origin.
- **Q101:** accepted for Phase 2. Self-hosting the fixed font list is a Phase 3 privacy follow-up.

## Follow-ups

- `apps/mobile/scripts/store-review.test.mjs` fails on develop (`@/auth/org-host-block` cannot be resolved), which points to a P2-T03 regression in a node-test script that CI does not run. It is assigned to the T04 agent as a small fix. P2-C02 should add the mobile node tests to CI.

## Verdict

Approved, to merge on fully green CI.
