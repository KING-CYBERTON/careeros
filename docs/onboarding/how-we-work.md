# How we work

This guide explains who decides what on CareerOS, how a task moves from an idea to merged code, and where work is handed from one thread to the next. It is for anyone joining the team, whether a person or a new Claude thread. It was generated from the prompt in [PROMPTS.md](PROMPTS.md#2-how-we-work-team-workflow) and summarises [PRODUCT.md](../../PRODUCT.md) Section 1, which always wins if the two disagree.

## 1. The three roles

| Role                 | Who           | Does                                                                                                                                                       | Never does                                                                                                                       |
| -------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Planner and Reviewer | Claude Opus   | Writes every plan, spec, test plan and CI/CD plan. Reviews every PR. Answers questions. Approves and merges before v1.0.0. Keeps `docs/STATUS.md` current. | Writes, edits or commits code, including test code, YAML or snippets meant to be pasted. Pseudo-code inside a plan is the limit. |
| Coder                | Claude Sonnet | Writes all code exactly as a spec says: application code, migrations, tests, scripts, workflows, Dockerfiles. Applies review fixes.                        | Plans or makes design choices. If a spec is unclear or seems wrong, Sonnet stops that part and asks in `docs/questions.md`.      |
| Owner                | Stephen       | Makes business decisions (name, pricing, customers, spending, legal). Gives the final sign-off on v1.0.0.                                                  | Day-to-day plan approvals and merges before v1.0.0.                                                                              |

## 2. Who approves what

Until v1.0.0 runs on both staging and production, Opus approves plans, answers technical questions, merges PRs to `develop` and `main`, and approves staging deploys and pre-release tags.

These go to Stephen instead, logged in [docs/ESCALATIONS.md](../ESCALATIONS.md):

- Business decisions, such as the open questions in PRODUCT.md §15, prices and legal text.
- Spending money, such as a new paid service or a plan upgrade.
- Irreversible destructive actions: deleting production data, dropping production tables, force-pushing or rewriting `main`, rotating production secrets, deleting cloud resources.
- Any blocker Opus cannot resolve.
- The v1.0.0 release sign-off.

After v1.0.0, Opus keeps approving day-to-day merges and Stephen approves each minor or major version release.

## 3. Threads

The original build runs in three parallel threads. They share no memory, so every hand-off goes through files in the repository.

| Thread            | Owns                                | Opus writes                                          | Sonnet writes                                    |
| ----------------- | ----------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| 1, Build          | Feature code                        | Phase plans and task specs in `docs/plans/`, reviews | Application code from Approved specs             |
| 2, QA and Testing | Test coverage and tenant isolation  | Test plans in `docs/test-plans/`, QA reviews         | Unit, integration, isolation, e2e and load tests |
| 3, CI/CD          | Pipelines, environments, deployment | Plans in `docs/plans/cicd/`, pipeline reviews        | Workflows, compose files, deploy scripts         |

The project also has threads outside that loop: go-to-market (taking the product to production and launch), marketing, product management (including an internal feature explainer for the team), and documentation and onboarding (this folder). They read the same hand-off files and follow the same roles. Any code they need still goes through an Approved spec and the build loop.

## 4. The life of a task

```text
Opus: spec + test plan, marked Approved
        |
        v
Sonnet: code on feature/<ID>-<slug>, PR to develop
        |
        v
Opus: review report in docs/reviews/  <-----+
        |                                   |
        v                                   |
Sonnet: fixes ---- Critical/High left? -----+
        | none left
        v
Thread 2 Sonnet: tests per test plan, CI green
        |
        v
Opus: merge, update docs/STATUS.md
```

1. Opus writes the spec in `docs/plans/<ID>-<name>.md` (scope, files, schema, acceptance criteria, risks) and the test plan in `docs/test-plans/<ID>.md`, checks them against PRODUCT.md, and marks the spec **Approved**.
2. Sonnet codes exactly to the spec on a feature branch and opens a PR that names the spec id.
3. Opus reviews the PR against the PRODUCT.md §1.6 checklist and writes `docs/reviews/<ID>-review-<n>.md`. Opus never edits the PR.
4. Sonnet applies the fixes. Opus re-reviews until no Critical or High findings remain.
5. The QA thread adds or updates tests from the test plan. CI must be green.
6. Opus merges and updates `docs/STATUS.md`.

A task is done only when it meets the Definition of Done in PRODUCT.md §14, which includes docs being updated.

## 5. Task ids

| Pattern           | Meaning                                                         | Example                    |
| ----------------- | --------------------------------------------------------------- | -------------------------- |
| `P<n>-T<nn>`      | Build task in phase n                                           | P3-T07 Super Admin console |
| `P<n>-Q<nn>`      | QA task                                                         | P1-Q03 cross-org id fuzz   |
| `P<n>-C<nn>`      | CI/CD task, kept in `docs/plans/cicd/` when it is pipeline work | P2-C01 staging org hosts   |
| `P<n>-M<nn>`      | Marketing site task                                             | P6-M01 marketing pages     |
| A trailing letter | A follow-up to an existing task                                 | P2-T03a, P6-T02a           |

Decisions carry their own ids: `D<n>` inside a phase plan, `G<n>` in the go-to-market plan, `E<n>` for escalations and `Q<n>` for questions.

## 6. Hand-off files

| File                                                 | Written by                               | Read it when                           |
| ---------------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| [docs/STATUS.md](../STATUS.md)                       | Opus, after every plan, review and merge | First, at the start of every session   |
| `docs/plans/<ID>-<name>.md`                          | Opus                                     | Before coding or reviewing a task      |
| `docs/plans/cicd/*.md`                               | Opus                                     | Before pipeline or infrastructure work |
| `docs/test-plans/<ID>.md`                            | Opus                                     | Before writing tests for a task        |
| `docs/reviews/<ID>-review-<n>.md`                    | Opus                                     | After a PR is reviewed                 |
| [docs/questions.md](../questions.md)                 | Sonnet asks, Opus answers                | When a spec leaves something open      |
| [docs/ESCALATIONS.md](../ESCALATIONS.md)             | Opus                                     | To see what waits on Stephen           |
| [docs/UPSTREAM_PATCHES.md](../UPSTREAM_PATCHES.md)   | Sonnet                                   | When touching an upstream file         |
| [CHANGELOG-CAREEROS.md](../../CHANGELOG-CAREEROS.md) | Sonnet                                   | To see what has shipped                |
| PR description                                       | Sonnet                                   | During review                          |

## 7. Questions and escalations

When a spec is unclear, incomplete or seems wrong, Sonnet stops that part of the work and adds an entry to `docs/questions.md` that names the spec, quotes the unclear part and lists the options it sees, without choosing one. Opus answers in the same file and, when the answer changes the spec, revises the spec. A question that is really a business, spending or legal decision goes to `docs/ESCALATIONS.md` for Stephen, with Opus's recommendation.

## 8. Review severity

| Severity | Meaning                                                                                              | Blocks merge |
| -------- | ---------------------------------------------------------------------------------------------------- | ------------ |
| Critical | A tenant data leak, a security hole or data loss. Any leak between organizations is always Critical. | Yes          |
| High     | A serious defect or a missed acceptance criterion                                                    | Yes          |
| Medium   | Should be fixed in the PR or filed as a follow-up                                                    | No           |
| Low      | Optional improvement                                                                                 | No           |

Every finding is written as `Severity · File:Line · Issue · Impact · Fix instruction for Sonnet`, with no ready-to-paste code.

## 9. The v1.0.0 release gate

Versions are `0.x.y` during the build phases (Opus tags one after each phase), then `1.0.0-rc.N` candidates on staging, then `1.0.0`. Code moves from `feature/*` to `develop` (which deploys to staging) to `main` (which deploys to production on a version tag).

Opus writes [docs/RELEASE-1.0.0.md](../RELEASE-1.0.0.md) when all of these hold:

1. Every P0 feature in PRODUCT.md §4 is done and accepted.
2. The same `1.0.0` build runs on staging and production with green health checks for 72 hours.
3. The full test suite and the tenant isolation suite pass, with no open Critical or High findings.
4. The security review, the load test and a backup restore drill are complete.
5. One-command deploy and one-command rollback are proven on production.
6. A pilot organization is onboarded with its own branding and domain.
7. Terms, privacy policy and DPA template are live, and the MIT `NOTICE` is present.

Stephen then reviews the report and the live URLs and approves or sends feedback, which Opus turns into specs.

## 10. Starting a new thread

Begin every new chat with the start prompt for its thread from [docs/THREAD-PROMPTS.md](../THREAD-PROMPTS.md). The short form is:

> You are in Thread N (name). Your model role is Opus-Planner/Reviewer or Sonnet-Coder. Read PRODUCT.md Section 1 and docs/STATUS.md before doing anything.
