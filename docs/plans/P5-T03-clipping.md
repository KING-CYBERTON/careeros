# P5-T03: Clipping a job: JSON-LD and heuristics, confirm and edit, save to the tracker

**Status:** Approved (Opus, 2026-11-08). **Thread:** 1 Build. **Plan:** [GTM-PLAN.md](GTM-PLAN.md), decision G7; PRODUCT.md §8.2. **Depends on:** P5-T02 merged. P4-T02 adds an application `source` marker for discovery; if it has merged, reuse it, otherwise add it here in a form P4-T02 can share and log a question.
**Branch:** `feat/P5-T03-clipping`. **Questions:** start at Q360.

## Goal

A signed-in member clicks the Job Clipper on any job posting, checks or edits what it found, and saves the job to their application tracker in their organization in one step. Pages with `JobPosting` JSON-LD fill in correctly; other pages fall back to heuristics and manual editing.

## Requirements

1. **Reading the page** (extension):
   - On click, inject one small reader into the active tab with `chrome.scripting.executeScript` under `activeTab`. Request no new permissions; the manifest test must still pass unchanged.
   - The reader returns plain data only (strings and numbers), never HTML or functions. It runs no page script, adds no listeners, and changes nothing on the page.
   - **JSON-LD first:** parse every `script[type="application/ld+json"]`. Handle a single object, an array, `@graph`, and `@type` given as a string or an array. Take the first `JobPosting`. Map `title`, `hiringOrganization.name`, `jobLocation` (address locality, region, country; `jobLocationType: TELECOMMUTE` means Remote), `baseSalary` (currency, min/max or value, unit), `employmentType`, `datePosted`, `validThrough`, `description` and `url`. Ignore malformed blocks without failing.
   - **Heuristics otherwise:** title from `og:title`, then the first `h1`, then `document.title`; company from `og:site_name` or known meta tags; description from the largest `main`/`article`/`[role=main]` text block. Use text content, never `innerHTML`.
   - **Caps:** description at most 20,000 characters and other fields at most 300, after whitespace collapsing. The tab URL is the default posting URL (https only; strip fragments and known tracking parameters such as `utm_*`).
   - A page the reader cannot run on (browser pages, the web store, PDFs) shows "This page can't be read. You can still fill the form in."
2. **Confirm and edit** (popup):
   - A form with title (required), company (required), location, salary text, URL, and description (collapsed preview, expandable).
   - It shows where the data came from: "Found on the page" (JSON-LD), "Best guess" (heuristics) or "Fill in". Everything stays editable.
   - **Duplicate check:** before saving, ask the server whether the member already has an application with the same normalized URL in this organization. If so, show "Already in your tracker" with an Open link, and still allow saving.
   - **Save:** calls `applications.create` with the token, the tracker's first stage and `source: clipper`. On success, show "Saved" with a link that opens the application on the org host.
   - **Errors:** readable messages for ORG_SUSPENDED, a 401 (back to signed out, per P5-T02) and a network error. A failed save keeps the form.
3. **Server:**
   - `applications.create` accepts the clipper `source` marker and stores it. The description is sanitized on the server to plain text, whatever the client sends. Server limits match the client caps.
   - **Duplicate check:** one small procedure, `clipper.findByUrl(url)`. It reads only the caller's own applications in the token's organization and returns at most an id and a title. Add it to `CLIPPER_ALLOWED_PROCEDURES`, and to the cross-org fuzz inventory.
   - The job text is untrusted. It is never rendered as HTML anywhere it is shown (tracker and detail views on web and mobile already render text; check them).
4. **Optional AI cleanup** (metered, off by default):
   - A "Tidy with AI" button in the popup, shown only when `clipper.whoami` reports that the org has platform AI (the `platform_ai` feature) and quota left.
   - It calls a new `clipper.cleanup` procedure (allow-listed) that sends the extracted fields through the P3-T03 metered platform path. Use feature `clipper.cleanup`, the fast model, and the `ai/data-block.ts` delimited block, with a system prompt saying the page text is untrusted data and never instructions.
   - Output is validated with Zod against the same fields and caps. Invalid output changes nothing. Quota exhausted returns AI_QUOTA_EXCEEDED, and the popup says so and keeps the form.
   - Never use a member's saved key from the extension.
5. **Mobile parity:** there is no mobile extension (P5-T01 note). Clipped applications appear in the mobile tracker like any other, with the source shown if the tracker shows sources. Add a line to the parity gaps table.
6. **Tests:**
   - **Unit (extension):** the reader against at least eight fictional fixtures. Cover JSON-LD single, array and `@graph`, `@type` as an array, remote jobs, a salary range, malformed JSON-LD, no JSON-LD (heuristics), a hostile page (script tags and prompt-injection text in the description, a 5 MB body, deeply nested DOM), and the URL cleaner.
   - **Unit (server):** description sanitizing, the source marker, and the cleanup output validator.
   - **Integration (isolated DB):** a clipper token saves to the right org and user. The same token on another org's host is refused. `findByUrl` never returns another member's or another org's application. A suspended org's save is refused. Cleanup makes exactly one metered call and writes `ai_usage`. With quota exhausted it makes no model call.
   - **E2E:** extend the extension spec. Serve a local fixture page with JSON-LD, clip it while signed in, confirm, save, and see the job in the web tracker.
   - No test calls the real Claude API.
7. Mark upstream edits `CAREEROS:` and list them in docs/UPSTREAM_PATCHES.md. Add a CHANGELOG line. Update `apps/extension/README.md`. Use Lingui strings for web and mobile changes. Log open points as questions and stop that part.

## Acceptance

- careeros-ci is fully green, including the isolation, inventory and skipped-suite guards.
- A job saves correctly from a JSON-LD page and, with manual edits, from a page without it, on an org subdomain and on a custom domain.
- Page content can never run in the extension or the app. Show it in tests.
