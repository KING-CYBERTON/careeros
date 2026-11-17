# PRODUCT.md — White-Label Career Platform (Working name: **CareerOS**)

> **Purpose of this file:** This is the single source of truth for building the product. It is meant to be added to a Claude Project as project knowledge. Every AI session working on this codebase must read and follow it, especially **Section 1 (AI Workflow Rules)**.
>
> Replace `CareerOS` with the final brand name when decided.

---

## 1. AI Workflow Rules (MANDATORY — read first)

### 1.1 Model roles (strict separation)

| Role                   | Model                                | Does                                                                                                                                                                                                                                                                | **Never does**                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Planner & Reviewer** | **Claude Opus** (latest available)   | Creates **all** plans: phase plans, task specs, schema designs, test plans, CI/CD plans. Reviews all code, tests, and pipelines (architecture, security, tenant isolation, coverage, performance, acceptance criteria). Writes review reports and fix instructions. | **Never writes, edits, or commits code** — not even small fixes, snippets meant to be pasted, test code, or pipeline YAML. Illustrative pseudo-code inside a plan is the limit.                                                          |
| **Coder**              | **Claude Sonnet** (latest available) | Writes **all** code exactly as specified in Opus plans: application code, migrations, tests, scripts, Dockerfiles, CI/CD workflows, configs. Fixes code per Opus review reports.                                                                                    | **Never plans or makes design decisions.** Does not choose architecture, schemas, libraries, scope, or task order. If a plan is unclear, incomplete, or seems wrong, Sonnet **stops and raises a question** to Opus instead of deciding. |
| **Owner**              | **Stephen** (human)                  | Answers business decisions (name, pricing, customers). **Gives one final approval: v1.0.0 running on both staging and production.**                                                                                                                                 | Not involved in day-to-day plan approvals or merges before v1.0.0.                                                                                                                                                                       |

### 1.1a Approval authority before v1.0.0

Until **v1.0.0 is up and running on both staging and production**, **Opus is the approver**:

| Decision                                                  | Who approves (pre-1.0.0)                                                                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plans, specs, test plans, CI/CD plans                     | Opus (self-review against this file)                                                                                                                                                           |
| Technical questions from Sonnet (`docs/questions.md`)     | Opus                                                                                                                                                                                           |
| PR merges to `develop` and `main`                         | Opus — after review passes, tests and CI green. Merging is an approval action, not code writing, so it is allowed.                                                                             |
| Staging deploys, pre-release tags (`0.x.y`, `1.0.0-rc.N`) | Opus                                                                                                                                                                                           |
| **Escalate to Stephen**                                   | Business decisions (§15 open questions, pricing, legal); spending money (new paid services, plan upgrades); irreversible destructive actions (see rule 1.5.4); any blocker Opus cannot resolve |
| **v1.0.0 release sign-off**                               | **Stephen** — Opus submits a release report when the v1.0.0 exit criteria (§13a) are met                                                                                                       |

After v1.0.0: Opus keeps approving day-to-day merges. Stephen approves each **version release** (minor/major tags) unless he says otherwise.

### 1.2 Three build threads

Work runs in **three parallel threads** (separate chats in the Claude Project). Threads do not share memory, so **all hand-offs happen through files in the repo** (see 1.4).

| Thread                      | Purpose                                  | Opus (plans & reviews)                                                                                     | Sonnet (codes)                                                                                 |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Thread 1 — Build**        | Initial and feature code                 | Writes phase plans and task specs (`docs/plans/`); reviews every PR                                        | Implements tasks from specs; applies review fixes                                              |
| **Thread 2 — QA & Testing** | Quality, test coverage, tenant isolation | Writes test plans and QA checklists (`docs/test-plans/`); runs QA reviews; files defects (`docs/reviews/`) | Writes unit, integration, isolation, E2E, and load tests per test plans; fixes failing tests   |
| **Thread 3 — CI/CD**        | Pipelines, environments, deployment      | Writes CI/CD and infrastructure plans (`docs/plans/cicd/`); reviews pipelines and infra changes            | Writes GitHub Actions workflows, Dockerfiles, compose files, deploy scripts, monitoring config |

**Thread start prompt** — begin every chat with: _"You are in Thread N (name). Your model role is Opus-Planner/Reviewer or Sonnet-Coder. Read PRODUCT.md Section 1 and docs/STATUS.md before doing anything."_

### 1.3 Workflow (every task)

```
Opus: plan/spec + approve ──► Sonnet: code (Thread 1 or 3)
      ▲                                         │
      │                                         ▼
Opus: re-review ◄── Sonnet: fix ◄── Opus: review (Thread 2 QA + thread owner)
      │
      ▼
Thread 2: Sonnet writes/runs tests per Opus test plan ──► CI (Thread 3) green ──► Opus merges
      │
      ▼  (only at v1.0.0, staging + production running)
Stephen: final sign-off
```

1. **Opus** writes the task spec in `docs/plans/` (scope, files, schema, acceptance criteria, risks) and the matching test plan in `docs/test-plans/`, and marks it **Approved** after checking it against this file.
2. **Sonnet** codes exactly to the spec on a feature branch and opens a PR referencing the spec ID.
3. **Opus** reviews the PR and writes a report in `docs/reviews/` (format in 1.6). Opus never edits the PR.
4. **Sonnet** applies fixes from the report; Opus re-reviews until no Critical/High findings remain.
5. **Thread 2 Sonnet** adds/updates tests per the test plan; CI (Thread 3) must be green.
6. **Opus** merges and updates `docs/STATUS.md`.
7. At v1.0.0 only: **Stephen** gives final sign-off (see §13a).

### 1.4 Hand-off files (shared memory between threads)

| File / folder                     | Written by                                                             | Purpose                                                                      |
| --------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `docs/STATUS.md`                  | Opus (updates after each review/plan)                                  | Current phase, active tasks per thread, blockers                             |
| `docs/plans/<ID>-<name>.md`       | Opus                                                                   | Task/phase specs (IDs like `P1-T03`)                                         |
| `docs/plans/cicd/*.md`            | Opus                                                                   | Pipeline and infra plans                                                     |
| `docs/test-plans/<ID>.md`         | Opus                                                                   | Test cases and coverage targets per task                                     |
| `docs/reviews/<ID>-review-<n>.md` | Opus                                                                   | Review findings and fix instructions                                         |
| `docs/questions.md`               | Sonnet (asks), Opus (answers; escalates business questions to Stephen) | Ambiguities Sonnet must not resolve on its own                               |
| `docs/ESCALATIONS.md`             | Opus                                                                   | Items waiting on Stephen (business, spending, destructive actions)           |
| `docs/RELEASE-1.0.0.md`           | Opus                                                                   | v1.0.0 release report for Stephen's sign-off                                 |
| PR description                    | Sonnet                                                                 | Links spec ID, lists what was implemented, notes deviations (should be none) |

### 1.5 Hard rules

1. **Opus never writes code.** No exceptions. Fixes are described in review reports and implemented by Sonnet.
2. **Sonnet never plans.** No architecture, schema, library, or scope decisions; anything not in a spec goes to `docs/questions.md`.
3. **No code without an approved spec.** Sonnet only starts a task whose spec Opus has marked Approved.
4. **No irreversible destructive actions without Stephen's permission:** deleting production data, dropping production tables, force-pushing/rewriting `main` history, rotating production secrets, or deleting cloud resources. Logged in `docs/ESCALATIONS.md`.
5. **Tenant isolation is a release blocker.** Any finding that could leak data between organizations is severity **Critical** and blocks merge.
6. **Never copy Teal** (tealhq.com) code, branding, copy, screenshots, or designs. Features are re-implemented originally.
7. **Keep MIT notices.** Preserve the copyright/license notices of Reactive Resume and JobSync in `LICENSE`/`NOTICE`.
8. **No secrets in code or chat.** Use environment variables and `.env.example` placeholders only.
9. **Claude API only** for in-product AI. Never use Claude Pro/Max subscription OAuth tokens in the product (prohibited by Anthropic's terms).

### 1.6 Opus QA review checklist (use on every PR)

- [ ] Meets the acceptance criteria of the task
- [ ] **Tenant isolation:** every query scoped by `organization_id`; RLS policy exists for new tables; no cross-org IDs accepted from client without verification
- [ ] AuthZ: role checks (super_admin / org_owner / org_admin / member) enforced server-side
- [ ] Input validation (zod / schema) on all API inputs
- [ ] No secrets, PII, or tokens logged
- [ ] Migrations are reversible and safe on existing data
- [ ] Tests: unit + integration; isolation test for any new tenant-scoped table
- [ ] Error handling and empty/loading states in UI
- [ ] Accessibility basics (labels, keyboard nav, contrast)
- [ ] Performance: no N+1 queries, indexes on `organization_id` + foreign keys
- [ ] AI calls: metered, rate-limited, prompt-injection safe (job postings = untrusted text)
- [ ] Upstream-merge friendliness: custom code kept in our packages, minimal edits to upstream files
- [ ] Docs/changelog updated

**Review output format:** `Severity (Critical/High/Medium/Low) · File:Line · Issue · Impact · Fix instruction for Sonnet` — saved to `docs/reviews/`. Opus never includes ready-to-paste code.

---

## 2. Product Overview

**CareerOS** is a white-label, multi-tenant career platform that combines a resume builder, job application tracker, AI career assistant, and automated job discovery. Organizations (universities, bootcamps, recruitment agencies, career coaches, NGOs, governments) license it and offer it to their users under their own brand and domain.

### 2.1 Goals

- Match or exceed the core functionality of commercial tools (e.g., Teal) using MIT-licensed foundations.
- Allow resale under each customer's brand (logo, colors, domain, emails).
- Support many organizations on shared infrastructure, with an optional dedicated deployment tier.
- Serve the East African market well (local job boards, M-Pesa, data protection compliance) while remaining global.

### 2.2 Non-goals (v1)

- Native mobile apps (responsive web only).
- Employer-side ATS / recruiting pipeline.
- Scraping sites whose terms prohibit it (LinkedIn, Indeed, etc.).

### 2.3 Foundations (MIT licensed)

| Source                 | Role                                                 | Repo                                               |
| ---------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| **Reactive Resume v6** | **Base codebase** (fork)                             | https://github.com/reactive-resume/reactive-resume |
| **JobSync**            | Feature reference — logic ported/re-implemented      | https://github.com/Gsync/jobsync                   |
| **Teal**               | Feature inspiration only — **no code/assets copied** | https://www.tealhq.com                             |

---

## 3. Users & Roles

| Role                       | Scope               | Capabilities                                                                                            |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| **Super Admin**            | Platform (us)       | Create/suspend orgs, plans, billing, global settings, usage & revenue dashboards, impersonate (audited) |
| **Org Owner**              | One organization    | Billing, branding, domain, admins, plan, AI limits                                                      |
| **Org Admin**              | One organization    | Manage members, invites, cohorts, view org analytics, email templates                                   |
| **Member (Job Seeker)**    | Own data within org | Resumes, cover letters, tracker, AI, job discovery                                                      |
| **Coach (optional, v1.1)** | Assigned members    | Read members' resumes/tracker (with consent), comment                                                   |

A user may belong to more than one organization; data is always scoped to the active org.

---

## 4. Feature Scope — "Best of Each Platform"

### 4.1 From Reactive Resume (already in base — keep & tenant-scope)

- Resume editor, 18 templates, design customization, live PDF preview
- Export PDF / DOCX / Markdown / JSON; import PDF / DOCX / LinkedIn / JSON Resume
- Cover letters with versions
- Resume checks: readability, ATS text view, keyword match, AI writing review
- Job application tracker (list, board, insights, calendar), contacts, interviews, follow-ups
- AI assistant with accept/reject edit proposals; Anthropic provider support
- Public resume links (password + stats)
- 2FA, passkeys, SSO providers, i18n, themes
- REST API + MCP server

### 4.2 From JobSync (port / re-implement)

| Feature                          | Description                                                                                                                                                                  | Priority                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Automated Job Discovery**      | Scheduled searches over Greenhouse, Lever, Ashby public job board APIs; local relevance pre-score; AI match on top N only (cost control); review queue → accept into tracker | P0                              |
| **Question Bank**                | Interview Q&A library tagged by skill; add from tracker or interview                                                                                                         | P1                              |
| **Job Timeline**                 | Per-job stage history: date, interviewers, questions asked                                                                                                                   | P1                              |
| **Company Pages & Watchlist**    | One page per company with jobs, contacts, links; watchlist feeds discovery                                                                                                   | P1                              |
| **Tasks & Activity Timer**       | Tasks linked to jobs; optional time tracking                                                                                                                                 | P2                              |
| **Daily/Weekly Goals Dashboard** | Progress widgets                                                                                                                                                             | P0 (merged with coaching below) |

### 4.3 Inspired by Teal (original implementation)

| Feature                               | Description                                                                                                                                                               | Priority |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Browser Extension ("Job Clipper")** | Chrome/Edge MV3 extension, white-labeled per org. One-click save of a job posting from any page (reads visible page content the user is viewing), maps to tracker via API | P0       |
| **Coaching Layer**                    | Weekly application goal, target role/date/salary, "Next Step" prompt per job, follow-up reminders, stage checklists                                                       | P0       |
| **Email Templates per Stage**         | Follow-up, thank-you, networking, negotiation templates; org admins can customize                                                                                         | P1       |
| **Broader Job Feed**                  | Licensed APIs (e.g., Adzuna) + regional boards via official feeds/partnerships (e.g., BrighterMonday, Fuzu, MyJobMag — **only with permission/API**)                      | P1       |
| **Career Content Hub**                | Org-editable articles, guides, resume examples                                                                                                                            | P2       |

### 4.4 New platform features (white-label business)

| Feature                                                                                            | Priority |
| -------------------------------------------------------------------------------------------------- | -------- |
| Multi-tenancy (organizations, roles, invitations, data isolation)                                  | P0       |
| White-label branding (logo, colors, fonts, app name, favicon, email sender, legal links)           | P0       |
| Custom domains + automatic SSL                                                                     | P0       |
| Billing: Stripe (cards) + M-Pesa (Daraja API); per-seat & plan-based                               | P0       |
| AI usage metering, quotas per org/plan, BYO-key option                                             | P0       |
| Super Admin console                                                                                | P0       |
| Org Admin console: members, cohorts, analytics (applications sent, interviews, offers), CSV export | P0       |
| Feature flags per plan/org                                                                         | P0       |
| Audit log                                                                                          | P1       |
| SSO for orgs (SAML/OIDC, e.g., university Google/Microsoft)                                        | P1       |
| Dedicated deployment tier (single-tenant install)                                                  | P1       |

---

## 5. Architecture

### 5.1 Tech stack (inherited from Reactive Resume v6)

| Layer       | Technology                                                                                |
| ----------- | ----------------------------------------------------------------------------------------- |
| Web app     | React 19 SPA, TanStack Router, Vite                                                       |
| Server      | Hono on Node.js 24                                                                        |
| Language    | TypeScript (strict)                                                                       |
| Monorepo    | pnpm + Turborepo                                                                          |
| Database    | PostgreSQL + Drizzle ORM                                                                  |
| API         | oRPC, OpenAPI REST, MCP                                                                   |
| Auth        | Better Auth (+ **organization plugin**)                                                   |
| UI          | Tailwind CSS, Base UI, shared UI package                                                  |
| State       | Zustand + TanStack Query                                                                  |
| PDF         | Forme; PDF.js viewer                                                                      |
| Rich text   | TipTap                                                                                    |
| i18n        | Lingui                                                                                    |
| Queue/cache | Redis (BullMQ or equivalent)                                                              |
| Storage     | S3-compatible (SeaweedFS / R2 / S3)                                                       |
| Email       | Resend or Amazon SES                                                                      |
| Payments    | Stripe, Safaricom Daraja (M-Pesa)                                                         |
| AI          | Anthropic Claude API (default), optional OpenAI/Gemini/Ollama via existing provider layer |

### 5.2 Monorepo layout (custom code isolated for upstream merges)

```
/apps
  /web                 # upstream (minimal edits)
  /server              # upstream (minimal edits)
  /extension           # NEW: browser extension (MV3)
  /admin               # NEW: super admin console (or route group in web)
/packages
  /tenancy             # NEW: org resolution, RLS helpers, context middleware
  /branding            # NEW: theme loading, CSS variables, email branding
  /billing             # NEW: Stripe + M-Pesa, plans, seats, webhooks
  /ai-metering         # NEW: usage tracking, quotas, provider key mgmt
  /job-discovery       # NEW: Greenhouse/Lever/Ashby/Adzuna fetchers, scoring, scheduler
  /coaching            # NEW: goals, next steps, reminders, email templates
  /interview-prep      # NEW: question bank, timeline
  /companies           # NEW: company pages, watchlist
  ...upstream packages
/infra
  docker-compose.yml   # shared deployment
  docker-compose.dedicated.yml
  /caddy or /cloudflare
NOTICE                  # MIT notices for Reactive Resume + JobSync
PRODUCT.md              # this file
```

### 5.3 Request flow

```
User → Cloudflare (DNS, SSL for SaaS, WAF, CDN)
     → App (Hono) → tenancy middleware:
         1. Resolve org from Host header (custom domain or <slug>.careeros.app)
         2. Load org branding + plan + feature flags (cached in Redis)
         3. Verify session user is a member of that org
         4. SET LOCAL app.current_org_id = '<uuid>' for the DB transaction (RLS)
     → Route handler → Drizzle → PostgreSQL (RLS enforced)
Background worker → job discovery, reminders, emails, AI batch jobs (always with explicit org context)
```

---

## 6. Multi-Tenancy Design

### 6.1 Model

- **Shared database, shared schema**, `organization_id UUID NOT NULL` on every tenant-scoped table.
- **PostgreSQL Row-Level Security (RLS)** on every tenant table:
  ```sql
  ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON <t>
    USING (organization_id = current_setting('app.current_org_id')::uuid);
  ```
- App connects with a non-superuser role (RLS cannot be bypassed). Super-admin/maintenance operations use a separate, audited role.
- Composite indexes `(organization_id, ...)` on all tenant tables.
- Better Auth **organization plugin** provides orgs, members, roles, invitations.

### 6.2 Core new tables (Drizzle)

| Table                                             | Key fields                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organization`                                    | id, name, slug, status (active/suspended/trial), plan_id, created_at                                                                                                      |
| `organization_branding`                           | org_id, app_name, logo_url, favicon_url, primary/secondary colors, font, email_from_name, email_from_address, support_url, terms_url, privacy_url, custom_css (sanitized) |
| `organization_domain`                             | org_id, hostname, status (pending/verified/active), cf_custom_hostname_id, verified_at                                                                                    |
| `member`                                          | org_id, user_id, role, cohort_id, invited_by, joined_at                                                                                                                   |
| `cohort`                                          | org_id, name, start/end dates                                                                                                                                             |
| `plan`                                            | id, name, price, seat_limit, ai_credits_monthly, features (jsonb)                                                                                                         |
| `subscription`                                    | org_id, provider (stripe/mpesa/manual), status, seats, period_start/end                                                                                                   |
| `ai_usage`                                        | org_id, user_id, feature, model, input_tokens, output_tokens, cost_usd, created_at                                                                                        |
| `ai_provider_key`                                 | org_id, provider, encrypted_key (BYO-key)                                                                                                                                 |
| `feature_flag`                                    | org_id (nullable = global), key, enabled                                                                                                                                  |
| `audit_log`                                       | org_id, actor_id, action, target, metadata, ip, created_at                                                                                                                |
| `job_source` / `discovery_run` / `discovered_job` | org_id, user_id, source, config, results, match_score, status (new/accepted/dismissed)                                                                                    |
| `question_bank`                                   | org_id, user_id, question, answer, tags                                                                                                                                   |
| `job_timeline_event`                              | org_id, job_id, stage, date, interviewers, notes                                                                                                                          |
| `company` / `company_watch`                       | org_id, user_id, name, links, board_urls                                                                                                                                  |
| `goal` / `reminder` / `email_template`            | org_id, user_id (nullable for org defaults), ...                                                                                                                          |

All existing upstream tables (resumes, letters, applications, contacts, interviews, assistant conversations) get `organization_id` via migration + RLS.

### 6.3 Isolation tests (required)

- For every tenant table: create data in Org A, authenticate as Org B, assert 0 rows via API **and** direct DB query under Org B context.
- Fuzz test: pass Org A resource IDs in Org B requests → expect 404.

### 6.4 Dedicated tier

Same codebase, deployed with `SINGLE_TENANT=true` and its own DB/storage. No code fork.

---

## 7. White-Label & Domains

- **Default domain:** `<slug>.careeros.app` (wildcard DNS + wildcard cert).
- **Custom domain:** org adds `careers.example.ac.ke` → CNAME to `customers.careeros.app` → verified via **Cloudflare for SaaS** custom hostnames (auto SSL). Self-hosted alternative: Caddy on-demand TLS with an `ask` endpoint that validates hostnames against `organization_domain`.
- **Theming:** branding loaded server-side, injected as CSS variables; no rebuild needed per org.
- **Emails:** branded templates; per-org sender name; optional verified sending domain per org.
- **Extension:** one generic extension that reads org branding after login (v1); per-org store listings for Enterprise (v2).
- **Remove/replace all upstream branding** in UI (MIT notice stays in `NOTICE` and an "Open-source licenses" page).

---

## 8. Module Specifications

### 8.1 Job Discovery (P0)

- Sources v1: Greenhouse (`boards-api.greenhouse.io`), Lever (`api.lever.co` / `api.eu.lever.co`), Ashby (public job board API). v1.1: Adzuna API (licensed key).
- User/org creates an automation: target titles, skills, locations, remote preference, companies (from directory or board URL), schedule (daily/weekly).
- Pipeline: fetch → dedupe → local relevance score (title/skill/keyword match) → AI match on top N (configurable, default 10) → review queue.
- Org admins can push "recommended companies" lists to cohorts.
- **Acceptance:** run completes within 2 min for 50 companies; AI calls ≤ N per run; accepted jobs appear in tracker with full description; dismissed jobs never reappear.

### 8.2 Browser Extension "Job Clipper" (P0)

- Manifest V3, Chrome + Edge.
- Auth: OAuth/device-code style login to the user's org domain; token stored in `chrome.storage.local`.
- On click: extract title, company, location, salary, description from the current page (generic heuristics + JSON-LD `JobPosting` schema when present); user confirms in popup → POST to `/api/applications`.
- Job posting text is **untrusted**: never executed; sanitized; AI extraction runs server-side with injection-safe prompts.
- **Acceptance:** saves correctly from pages with `JobPosting` JSON-LD; manual-edit fallback for others; works with custom domains.

### 8.3 Coaching Layer (P0)

- Career goal: target title, target date, salary range.
- Weekly application goal with progress ring; pipeline counts by stage over date range.
- "Next Step" per job, derived from stage (e.g., Saved → "Tailor resume", Applied → "Follow up in 7 days").
- Reminders (in-app + email) for follow-ups and deadlines.
- Stage checklists (org-customizable).
- **Acceptance:** dashboard reflects tracker changes in real time; reminders delivered at user timezone.

### 8.4 AI Features (P0)

- Match score + keyword gap (resume vs job description)
- Tailored bullets, professional summary, cover letter, resume rewrite
- Interview prep: likely questions from job description → save to Question Bank
- Org-level system prompt additions (e.g., university tone guidelines)
- **Metering:** every AI call logs tokens/cost to `ai_usage`; enforce plan quotas; soft warning at 80%, hard stop at 100% (configurable overage).
- Default model routing: Claude Sonnet for generation, Claude Haiku for cheap classification/extraction (configurable).

### 8.5 Question Bank, Timeline, Companies (P1)

Port behavior from JobSync; re-implement on Drizzle/oRPC with tenant scoping.

### 8.6 Email Templates (P1)

Org default library + user copies; variables (`{{company}}`, `{{contact_name}}`, `{{job_title}}`); copy-to-clipboard and mailto (no sending from user mailbox in v1).

### 8.7 Admin Consoles (P0)

- **Super Admin:** orgs CRUD, suspend, plan assignment, usage/revenue, AI cost vs revenue per org, impersonation (audited), global announcements.
- **Org Admin:** members/invites (bulk CSV), cohorts, branding, domain, email templates, analytics (active users, resumes created, applications, interviews, offers), CSV export, AI quota view.

### 8.8 Billing (P0)

- Plans: **Starter / Pro / Enterprise** (see §11).
- Stripe Billing: subscriptions, per-seat quantity, invoices, customer portal, webhooks.
- M-Pesa via Daraja: STK Push for monthly/annual payments; reconcile via callback → `subscription`.
- Manual invoicing option for institutions (super admin marks paid).
- Trial: 14 days, limited seats.

---

## 9. Security & Compliance

- RLS + server-side authZ on every route; no client-trusted org IDs.
- Encrypt BYO API keys at rest (`ENCRYPTION_SECRET`); never return them to the client.
- Rate limiting per IP, user, and org; extra limits on AI and auth endpoints.
- Audit log for admin actions, impersonation, exports, role changes.
- Backups: nightly encrypted DB dumps + storage sync to a separate provider; monthly restore test.
- Data export & account deletion per user; org offboarding export.
- **Kenya Data Protection Act 2019:** register with ODPC as data processor/controller as applicable; DPA template for each org; breach notification process.
- **GDPR** readiness for EU users (DPA, subprocessors list, data residency notes).
- Dependency scanning (Dependabot/Renovate), secret scanning, Sentry for errors.
- Prompt-injection safety: job postings and uploaded docs treated as untrusted data in all AI prompts.

---

## 10. Hosting & Deployment

| Stage                        | Setup                                                                                              | Est. monthly       |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------ |
| Pilot (1–3 orgs, <500 users) | 1 VPS (4 vCPU/8 GB) — Docker Compose: app, worker, Postgres, Redis, SeaweedFS; Cloudflare in front | $15–40             |
| Early (10–30 orgs)           | App VPS + managed Postgres + S3/R2                                                                 | $80–250            |
| Growth (50+ orgs)            | 2+ app nodes + LB, managed Postgres w/ failover, Redis, monitoring                                 | $400–1,500+        |
| Enterprise dedicated         | Per-customer stack on their preferred cloud/region (AWS Cape Town, Azure/GCP South Africa, etc.)   | billed to customer |

- Providers: Hetzner/OVH (cost), DigitalOcean (simplicity), AWS/Azure (enterprise).
- CI/CD: GitHub Actions → build Docker images → GHCR → deploy (tagged releases; staging before prod).
- Environments: `local`, `staging`, `production`.
- Monitoring: uptime checks, Sentry, Postgres metrics, AI cost dashboard.
- AI API cost (passed through via plans): est. $0.01–0.05 per action.

---

## 11. Pricing (initial hypothesis — to validate)

| Plan                              | Target                                | Price idea                    | Includes                                                                        |
| --------------------------------- | ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| **Starter**                       | Coaches, small agencies               | $X / month, up to 50 seats    | Subdomain, branding, core features, AI quota                                    |
| **Pro**                           | Bootcamps, mid agencies, colleges     | per seat / month              | Custom domain, job discovery, admin analytics, larger AI quota, email templates |
| **Enterprise**                    | Universities, governments, large NGOs | annual contract               | SSO, dedicated deployment option, data residency, SLA, custom onboarding        |
| **Direct-to-consumer (optional)** | Individual job seekers                | below market (e.g., < $29/mo) | Own brand                                                                       |

M-Pesa pricing in KES for local customers.

---

## 12. Upstream Sync Strategy

- Fork `reactive-resume/reactive-resume`; keep `upstream` remote.
- Monthly: merge upstream release into `upstream-sync` branch → run full test suite + isolation tests → Opus review → merge.
- Keep edits to upstream files minimal and marked with `// CAREEROS:` comments; put logic in `/packages/*`.
- Track every upstream file we modify in `docs/UPSTREAM_PATCHES.md`.

---

## 13. Roadmap & Milestones

Each phase follows the §1 workflow: Opus writes and approves the phase plan and test plan, then Sonnet codes. All three threads run in parallel within each phase:

| Thread           | Ongoing work every phase                                                       |
| ---------------- | ------------------------------------------------------------------------------ |
| 1 — Build        | Feature code for the phase                                                     |
| 2 — QA & Testing | Test plans (Opus) → tests (Sonnet); isolation suite grows with every new table |
| 3 — CI/CD        | Pipeline updates, new env vars/secrets, migrations in deploy, staging deploys  |

| Phase                         | Scope                                                                                                                                                                                                                           | Duration (est.) | Exit criteria                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------- |
| **0. Setup**                  | Fork, NOTICE file, coding standards, `docs/` hand-off structure. **Thread 3:** CI (lint, typecheck, test, build), Docker images to GHCR, staging env. **Thread 2:** test harness (Vitest, Playwright), isolation-test framework | 1 week          | Upstream app runs in staging; CI green; all three threads operational |
| **1. Multi-tenancy**          | Better Auth org plugin, `organization_id` migrations, RLS, tenancy middleware, roles, invites                                                                                                                                   | 2–3 weeks       | All isolation tests pass; Opus sign-off (no Critical/High)            |
| **2. White-label**            | Branding tables/UI, theming, subdomains, custom domains + SSL, branded emails, remove upstream branding                                                                                                                         | 1–2 weeks       | Two orgs on different domains with distinct branding in staging       |
| **3. Admin & Billing**        | Super admin + org admin consoles, plans, Stripe, M-Pesa, feature flags, AI metering/quotas                                                                                                                                      | 2–3 weeks       | Test org can subscribe, add seats, hit AI quota                       |
| **4. JobSync features**       | Job discovery, question bank, timeline, companies/watchlist, tasks                                                                                                                                                              | 2–3 weeks       | Discovery runs on schedule; acceptance criteria §8.1 met              |
| **5. Teal-inspired features** | Extension, coaching layer, email templates, broader job feed                                                                                                                                                                    | 3–4 weeks       | Extension saves jobs to correct org; coaching dashboard live          |
| **6. Hardening & Launch**     | Security review, load test, backups/restore drill, legal docs, onboarding docs, pilot org, `1.0.0-rc.N` candidates on staging                                                                                                   | 2 weeks         | v1.0.0 release gate (§13a) passed; Stephen signs off                  |

**Total:** ~3–4 months to sellable v1.

### 13a. Versioning & the v1.0.0 Release Gate

- **Semantic Versioning.** `0.x.y` during build phases (Opus tags after each phase), `1.0.0-rc.N` release candidates, then `1.0.0`.
- **Branches.** `feature/*` → `develop` (auto-deploys to **staging**) → `main` (deploys to **production** on version tag).
- **Until v1.0.0, Opus approves and merges everything** (see 1.1a). Stephen is not asked to approve merges.

**v1.0.0 exit criteria** (Opus checks all, then writes `docs/RELEASE-1.0.0.md`):

1. All P0 features from §4 done and accepted against their specs.
2. Same build (`1.0.0`) **running on staging and production**, health checks green for 72 hours.
3. Full test suite + tenant isolation suite passing; zero open Critical/High findings.
4. Security review complete (Thread 2), load test meets targets, backup restore drill passed.
5. CI/CD (Thread 3): one-command deploy and one-command rollback proven on production.
6. Pilot organization onboarded with custom branding and domain.
7. Legal docs live (Terms, Privacy, DPA template); MIT `NOTICE` present.

**Stephen's sign-off:** reviews `docs/RELEASE-1.0.0.md` and the live staging and production URLs, then approves v1.0.0. If he rejects it, Opus turns the feedback into specs and the loop continues.

---

## 14. Definition of Done (every task)

1. Built from an Approved Opus spec; no unapproved deviations.
2. Acceptance criteria met and demonstrated.
3. Tests from the Opus test plan written by Sonnet (Thread 2): unit + integration + isolation test for tenant data.
4. Opus QA review complete — no open Critical/High findings; review saved in `docs/reviews/`.
5. CI pipeline green (Thread 3); staging deploy succeeds.
6. Migrations tested up and down on a copy of staging data.
7. Docs updated (README, API docs, `UPSTREAM_PATCHES.md` if relevant); `docs/STATUS.md` updated by Opus.
8. Opus approves and merges. (Stephen's approval is required only for the v1.0.0 release, per §13a.)

---

## 15. Open Questions (to resolve with Stephen)

1. Final product name and primary domain.
2. First target customer segment (universities vs agencies vs coaches vs direct consumers).
3. Initial hosting provider and region.
4. Pricing numbers and currency strategy (USD vs KES).
5. Which regional job boards can we partner with for official feeds?
6. Is a coach role needed in v1?
7. Default AI quota per seat per plan.

---

## 16. References

- Reactive Resume (MIT): https://github.com/reactive-resume/reactive-resume · License: https://docs.rxresu.me/legal/license
- JobSync (MIT): https://github.com/Gsync/jobsync
- Better Auth organization plugin docs: https://www.better-auth.com/docs/plugins/organization
- Cloudflare for SaaS: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/
- Anthropic API docs: https://docs.claude.com
- Safaricom Daraja API: https://developer.safaricom.co.ke
- Kenya ODPC: https://www.odpc.go.ke
