# Onboarding documents

Internal documentation for the CareerOS team: engineers, reviewers, operators and whoever onboards customer organizations. These pages are not part of the public docs site. [PRODUCT.md](../../PRODUCT.md) wins over anything here.

| Document                                             | For                                   | Answers                                                                          |
| ---------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| [How we work](how-we-work.md)                        | Everyone, people and Claude threads   | Who decides what, the life of a task, hand-off files, the release gate           |
| [Developer onboarding](developer-onboarding.md)      | Engineers and Sonnet sessions         | Setup, repository map, commands, the rules that fail review, CI, PRs             |
| [Architecture tour](architecture-tour.md)            | Engineers and reviewers               | How tenancy, branding, billing, AI, discovery, the clipper and the consoles work |
| [Operations onboarding](operations-onboarding.md)    | Whoever runs staging and production   | Deploys, rollback, tags, workflows, secrets, routine tasks                       |
| [Pilot organization playbook](pilot-org-playbook.md) | The team member onboarding a customer | Setting up and supporting a new organization, common problems                    |
| [Glossary](glossary.md)                              | Everyone                              | Plain definitions of CareerOS terms                                              |
| [PROMPTS.md](PROMPTS.md)                             | Whoever keeps these current           | One prompt per document to regenerate it                                         |

## Reading order by role

- **Engineer:** How we work, Developer onboarding, Architecture tour, Glossary as needed.
- **Reviewer:** How we work, Architecture tour, then PRODUCT.md §1.6 and a recent review in `docs/reviews/`.
- **Operator:** How we work, Operations onboarding, then `infra/staging/README.md`.
- **Onboarding lead:** Glossary, Pilot organization playbook, the relevant parts of Operations onboarding.

## Keeping them current

Each document names the prompt that generated it. Run that prompt from [PROMPTS.md](PROMPTS.md) in a new Opus thread when its "Refresh when" condition is met, for example after a phase exits or a runbook changes. All documents were last checked against `develop` on 2026-11-11.
