# Onboarding document prompts

Each section below is a self-contained prompt that generates or refreshes one document in `docs/onboarding/`. Paste it as the first message of a new Claude thread on this repository. Use **Claude Opus**: these are documents, not code, so they sit with the Planner and Reviewer role (PRODUCT.md §1.1).

Run a prompt again whenever the facts under it change: a phase exits, a package is added, a runbook moves, or a decision in `docs/ESCALATIONS.md` is settled. The "Refresh when" line under each prompt says what to watch for.

## Rules shared by every prompt

Every prompt below includes this block. Keep it in sync if you edit it.

> **Shared rules.** Read PRODUCT.md Section 1 and `docs/STATUS.md` first. PRODUCT.md wins over everything else. Write for a reader who is new to CareerOS and has not seen any earlier chat: plain, full sentences, no shorthand, no chat references. Every claim about the system must be checked against the repository (code, `.env.example`, workflows, runbooks) on `develop`, not against memory or older docs; when the code and a doc disagree, the code wins and you note the mismatch at the end of your reply. Link to the source file or runbook instead of copying long procedures, so there is one place to update. Never include secrets, real keys, passwords, personal data or customer names. Use only the public product name "CareerOS" (final name still open, PRODUCT.md §15.1). Do not write or change code. Do not edit `docs/STATUS.md`, plans, reviews or test plans from this thread. Save the document at the path given, then open a pull request to `develop` titled `docs(onboarding): <document>`.

---

## 1. Developer onboarding

**Output:** `docs/onboarding/developer-onboarding.md`
**Audience:** a new engineer, or a new Sonnet coding session, on their first day.
**Refresh when:** setup steps, Node or pnpm versions, CI jobs, test commands or the package list change.

```text
You are writing CareerOS's developer onboarding guide.

[Shared rules block from docs/onboarding/PROMPTS.md]

Sources to read: PRODUCT.md (§1, §5, §6, §12, §14), docs/CODING-STANDARDS.md, docs/STATUS.md, AGENTS.md (setup, checks and code style sections), CLAUDE.md, .env.example (the CAREEROS blocks), package.json scripts, the package.json of every package named @careeros/*, packages/tenancy/README.md, packages/isolation-testing/README.md, .github/workflows/careeros-ci.yml, tooling/careeros/*.mjs, docs/UPSTREAM_PATCHES.md and docs/BASELINE.md.

Structure:
1. What CareerOS is in five sentences, and how it relates to Reactive Resume (fork, MIT, upstream sync).
2. Repository map: a table of apps and packages split into "upstream" and "CareerOS", each with one line on what it owns.
3. Local setup from a clean machine to a running app, including the CareerOS test database role, with the exact commands.
4. Everyday commands: dev, typecheck, lint, format, unit tests for one package, database suites, e2e, boundaries.
5. The five rules that most often fail review: tenant scoping and RLS, never trusting a client org id, CAREEROS: markers and UPSTREAM_PATCHES.md, the branding gate, database suites that must not skip in CI.
6. How to add a tenant table, end to end (schema, migration, policy, isolation registry, tests).
7. CI: each careeros-ci job, what it checks, and how to read a failure.
8. Branches, commits and PRs: naming, Conventional Commits, what the PR description must contain.
9. A first-week checklist with links.

Keep it under about 2,500 words. Use tables for maps and lists of commands.
```

## 2. How we work (team workflow)

**Output:** `docs/onboarding/how-we-work.md`
**Audience:** anyone joining the team, human or Claude thread, who needs to know who decides what and where work is handed off.
**Refresh when:** PRODUCT.md §1 changes, a thread is added or removed, or the approval rules change after v1.0.0.

```text
You are writing "How we work", the team workflow guide for CareerOS.

[Shared rules block from docs/onboarding/PROMPTS.md]

Sources to read: PRODUCT.md §1 (all of it), §13, §13a and §14; docs/THREAD-PROMPTS.md; docs/plans/README.md; docs/reviews/README.md; docs/test-plans/README.md; docs/questions.md (structure only, skim the last 20 entries for the current style); docs/ESCALATIONS.md; docs/STATUS.md.

Structure:
1. The three roles (Opus, Sonnet, Stephen) and the one-line rule each must never break.
2. Who approves what, before and after v1.0.0.
3. The build threads and what each owns, plus the newer project threads (go-to-market, marketing, product management, documentation) and how they relate.
4. The life of a task, from spec to merge, as a numbered walkthrough with the file written at each step.
5. Task ids: P<phase>-T, -Q, -C and -M, and lettered follow-ups such as P2-T03a.
6. Hand-off files: a table of each file, who writes it and when to read it.
7. How to ask a question, how Opus answers, and when something goes to Stephen instead.
8. Severity levels in reviews and what blocks a merge.
9. The v1.0.0 release gate in plain language.
10. How to start a new thread: the start prompt to paste.

Include one simple diagram of the task loop as a Markdown code block. Keep it under about 1,800 words.
```

## 3. Architecture tour

**Output:** `docs/onboarding/architecture-tour.md`
**Audience:** engineers and reviewers who need to understand how CareerOS's own layer works on top of the upstream app.
**Refresh when:** a phase adds a package, a table family, a request path or an external service.

```text
You are writing the CareerOS architecture tour.

[Shared rules block from docs/onboarding/PROMPTS.md]

Sources to read: PRODUCT.md §5 to §9; docs/plans/P1-PHASE-PLAN.md, P2-PHASE-PLAN.md, P3-PHASE-PLAN.md and GTM-PLAN.md (key decisions tables); CHANGELOG-CAREEROS.md; the source and README of each @careeros/* package; packages/api/src/features (folder names, and the router of any CareerOS feature); apps/server/src (startup checks and CareerOS routes); apps/extension/README.md; infra/db/bootstrap-roles.sql.

Structure:
1. One diagram of a request from the browser to PostgreSQL, naming the host resolution, session check, org context and RLS steps.
2. Tenancy: organizations, members and roles, how the host decides the org, withOrgContext and captureOrgScope, the careeros_app and careeros_owner roles, FORCE RLS, and what fails closed.
3. White-label: branding tables, how branding reaches the app shell, emails and mobile, custom domains through Cloudflare for SaaS, the sign-in handoff on org hosts.
4. Plans, entitlements and billing: getEntitlements, feature resolution order, seats, suspension, the billing state machine, webhooks and the providers that exist.
5. AI: user keys versus the platform Claude key, metering, credits, the 80% and 100% behaviour, untrusted text in prompts.
6. Job discovery and the Job Clipper: sources, allow-list, scoring, the review queue, device sign-in and host-bound tokens.
7. Consoles: the Super Admin console and the Org Admin pages, and how platform admins are granted.
8. Email delivery and suppression.
9. A "where is it" table: concern, package or folder, key file.
10. Known gaps that are planned but not built (from PRODUCT.md and STATUS.md), clearly marked.

Keep it under about 3,000 words. Name tables and functions exactly as they are in code.
```

## 4. Operations onboarding

**Output:** `docs/onboarding/operations-onboarding.md`
**Audience:** whoever runs staging and, later, production: deploys, rollbacks, releases, platform admins, secrets.
**Refresh when:** the production environment (G8) is decided, a runbook changes, or a new external service or secret is added.

```text
You are writing the CareerOS operations onboarding guide.

[Shared rules block from docs/onboarding/PROMPTS.md]

Sources to read: infra/staging/README.md, infra/staging/*.sh, .github/workflows/careeros-*.yml, docs/runbooks/*.md, docs/plans/cicd/*.md, docs/plans/GTM-PLAN.md (G8 to G11), .env.example and .env.staging.example (variable names only), docs/STATUS.md (waiting-on-Stephen and blockers), docs/ESCALATIONS.md.

Structure:
1. Environments today (local, CI, staging) and what is still open for production.
2. How code reaches staging, step by step, and how to tell which build is live.
3. Rollback: automatic and manual, and the limit that migrations are forward-only.
4. Cutting a release tag and what the tag publishes.
5. A table of every workflow named careeros-*: trigger, what it does, who runs it.
6. Secrets and variables: names only, where each one lives (server .env, GitHub environment, repository secret), and what breaks when it is missing.
7. Routine owner tasks: granting a platform admin, adding an org host or custom domain, email through Plunk, Paystack keys, the Job Clipper store release.
8. Destructive actions that need Stephen's written approval (PRODUCT.md §1.5.4).
9. Open operational items from STATUS.md, each with its owner.

Link to the runbooks for the full commands; quote only the short ones. Keep it under about 2,000 words.
```

## 5. Pilot organization onboarding playbook

**Output:** `docs/onboarding/pilot-org-playbook.md`
**Audience:** the CareerOS team member who sets up and supports a new customer organization. It is a team playbook, not a customer handout.
**Refresh when:** an Org Admin or Super Admin page changes, billing goes live, or the pilot org (§13a item 6) gives feedback.

```text
You are writing the playbook the CareerOS team follows to onboard a pilot organization.

[Shared rules block from docs/onboarding/PROMPTS.md]

Sources to read: PRODUCT.md §3, §7, §8.7, §8.8, §11, §13a; docs/plans/P2-T07-branding-settings-ui.md, P3-T06-billing-ui.md, P3-T07-super-admin-console.md, P3-T08-org-admin-console.md, P5-T04-email-templates-per-stage.md; apps/web/src/routes/dashboard/settings/route.tsx (the exact page labels) and apps/web/src/routes/admin; infra/staging/README.md (Platform admins, Org hosts and custom domains); docs/legal/*.md (status only).

Structure:
1. Before the call: what to collect from the customer (name, address slug, logo, colours, domain, admins, seat count, cohort list, legal links), as a checklist.
2. Day 0, platform side: create or find the org, set the plan and seats in the Super Admin console, check the org address resolves.
3. Day 0, customer side: walk the owner through Branding, Domains, Members & invites (CSV with dry run), Cohorts and Org email templates, using the exact menu labels.
4. Billing: what the owner sees today, manual payment for institutions, and what is still waiting on prices (D2) and Paystack keys.
5. Week 1: Analytics, AI usage and the Audit log; what healthy numbers look like; when to step in.
6. Support: how a support session (impersonation) works, its limits and its audit trail, and when not to use it.
7. Common problems and fixes: domain not verifying, seat limit reached, suspended org, AI quota exceeded, emails not arriving.
8. Exit check for the pilot (the §13a item 6 evidence to record).

Mark anything that depends on an open decision with "(open: D2)" or similar. Keep it under about 2,000 words.
```

## 6. Glossary

**Output:** `docs/onboarding/glossary.md`
**Audience:** everyone. It defines CareerOS terms; the upstream `GLOSSARY.md` stays the translators' glossary for interface strings.
**Refresh when:** a new term appears in specs, reviews or the interface.

```text
You are writing the CareerOS team glossary.

[Shared rules block from docs/onboarding/PROMPTS.md]

Sources to read: PRODUCT.md, docs/STATUS.md, the key decisions tables in docs/plans/*-PHASE-PLAN.md and GTM-PLAN.md, CHANGELOG-CAREEROS.md, docs/CODING-STANDARDS.md, and the root GLOSSARY.md (to avoid clashing with it).

Write one alphabetical list. Each entry: the term in bold, a one or two sentence definition in plain words, and where it lives (file, table or page) when that helps. Cover at least: organization, personal organization, org host, platform host, custom domain, slug, member roles, platform admin, support session, cohort, plan, entitlements, feature flag, seat, trial, grace period, suspended, AI credits, platform AI, BYO key, metering, RLS, FORCE RLS, careeros_app, careeros_owner, withOrgContext, definer function, isolation registry, cross-org fuzz, branding gate, handoff, device flow, clipper token, job source, discovery run, review queue, Job Clipper, CAREEROS: marker, upstream sync, spec, test plan, review, escalation, decision ids (D, G, E, Q), task ids.

Keep each definition short. No marketing language.
```

## 7. Onboarding index

**Output:** `docs/onboarding/README.md`
**Refresh when:** a document is added, renamed or retired.

```text
Update docs/onboarding/README.md, the index of CareerOS onboarding documents.

[Shared rules block from docs/onboarding/PROMPTS.md]

List every document in docs/onboarding/ with its audience, what it answers, and the order a new person should read them in, by role (engineer, reviewer, operator, onboarding lead). Say that PROMPTS.md regenerates each document and when to run it. Keep it under 400 words.
```
