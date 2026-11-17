# P6-T01: Terms, privacy policy and DPA drafts, and their pages

**Status:** Approved (Opus, 2026-11-02). **Thread:** 1 Build. **Plan:** [GTM-PLAN.md](GTM-PLAN.md), decision G10.
**Branch:** `feat/P6-T01-legal-pages`. **Questions:** start at Q280.

## Goal

CareerOS has plain-language legal pages that Stephen (or his lawyer) can approve before launch: terms of service, a privacy policy, and a data processing addendum (DPA) for org customers. Org hosts keep showing their own legal links when the org has set them (P2-T01).

## Requirements

1. **Drafts** in `docs/legal/` as Markdown, each starting with a clear banner: "Draft for review. Not legal advice. Not in force until approved." Write them in plain language, short sections, no copied text from other companies' policies.
   - `terms.md`: who the service is for (organizations and their members, and individuals on the personal plan), accounts, acceptable use, customer content and who owns it, AI features (outputs may be wrong; the member reviews before use; content sent to the AI provider), job discovery and the clipper (third-party job data is shown as found), plans and payment (pointing at the billing terms to be confirmed with D1), suspension and termination, export of data, open-source notice (the product is built on Reactive Resume under the MIT licence; link the `/licenses` page), liability limits and governing law as placeholders marked `[TO CONFIRM]`.
   - `privacy.md`: the controller and contact as placeholders, what data is collected (account, profile, resumes, applications, uploaded files, usage and AI usage records, logs), why (contract, legitimate interest, consent where needed), processors (hosting, email, the Claude API for AI features, the payment provider once D1 is decided) as a table with placeholders, retention, international transfers, rights under Kenya's Data Protection Act 2019 and the GDPR (access, correction, deletion, objection, portability, complaint to the ODPC or a supervisory authority), cookies (session cookies only; no third-party trackers unless added later), children (not for under 16s), changes.
   - `dpa.md`: for org customers. The org is the controller for its members' data and CareerOS the processor; subject matter, duration, categories of data and data subjects; processor duties (instructions only, confidentiality, security measures summarized from what the product actually does: per-tenant isolation with row-level security, encryption in transit, encrypted secrets, backups per G9), sub-processors list with placeholders and notice of changes, assistance with data subject requests, breach notice within 72 hours, deletion or return at the end, audits.
   - Every fact about how the product handles data must match the code today. Where unsure, check the code; where it cannot be confirmed, mark it `[TO CONFIRM]` and log a question. Never claim a certification the product does not have.
2. **Pages.**
   - Public routes `/terms`, `/privacy` and `/dpa` on the web app, rendering the Markdown from `docs/legal/` at build time (bundle it; no runtime fetch of repository files). Keep the draft banner visible on the page until a `LEGAL_PAGES_APPROVED` constant in code is set to true by a later change.
   - The routes are public marketing routes, so also update the server fallback and SEO handling in `apps/server/src/static/web.ts` (AGENTS.md: Vite's dev fallback can hide production 404s).
   - On an org host, the footer and sign-up legal links use the org's own `termsUrl` and `privacyUrl` when set, and these platform pages otherwise. Check the existing P2-T01 behaviour and only fill the gap where the platform default is missing today.
   - The sign-up form shows "By creating an account you agree to the Terms and the Privacy policy" with links (Lingui strings), on web and mobile.
   - Mobile parity: the mobile app links to the same pages (opened in the in-app browser) from its settings and sign-up screens.
3. **Translations.** Page chrome uses Lingui. The legal text itself is English only for now; note that in the page.
4. **Tests.** Route tests that each page renders with the banner; the server serves the three routes in production mode (not a 404); the org-host link rule picks the org's URL when set and the platform page otherwise.
5. Add a CHANGELOG line. Mark upstream edits `CAREEROS:` and list them. Log open points as questions and stop that part.

## Acceptance

- careeros-ci is fully green.
- `/terms`, `/privacy` and `/dpa` load in the production build on the platform host and on an org host, with the draft banner.
- The drafts contain no claim that the code does not support, and every unknown is marked `[TO CONFIRM]`.
- Stephen is asked to approve the drafts (a STATUS "waiting on Stephen" line); launch waits on that approval.
