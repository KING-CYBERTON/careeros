# P2-C01 review 1

**PR:** #58 · **Reviewer:** Opus · **Date:** 2026-11-02

## Checked

- **Secrets.** Tokens come only from step environment. Workflow inputs reach the script through `env`, never interpolated into `run`, so there is no script injection. All output passes through a scrubber, and a test asserts that tokens never appear, including on an API error. `permissions: contents: read`, `environment: staging`.
- **Destructive guardrails.** `org-dns-remove` deletes one record, only when it is tagged `careeros-staging-managed` and its name matches `ORG_HOST_PATTERN`. Nothing deletes in bulk. `fallback-origin` refuses a name that matches the pattern.
- **Idempotency.** Each command reads first and writes only the difference, and the tests prove a second `--apply` makes no write.
- **CI.** The static job runs the new self-test. The deploy smoke step is optional and skips with a notice.

## Answers

- **Q160:** yes. Reject a slug with a leading or trailing hyphen, because the result would not be a valid DNS label. Add a test.
- **Q161:** no adopt flag. An untagged record is left alone if it is already correct and refused otherwise. The operator fixes it in the dashboard.
- **Q162:** use the existing variable. The fallback origin name is `CF_SAAS_CNAME_TARGET`, the same value the app gives customers, so the two cannot drift. Require it, keep the pattern-match refusal, and pass it in the workflow as a `staging` variable. Update the runbook.
- **Q163:** accepted. The diff the command prints shows what is dropped.
- **Q164:** accepted. Say in the runbook that a dry run makes read-only calls and needs the tokens.

## Verdict

Approved after Q160 and Q162. Merge on fully green CI.
