# docs/reviews — review reports (Opus only)

File name: `<ID>-review-<n>.md`. Each report: PR link, commit reviewed, checklist (PRODUCT.md §1.6) results, findings table, verdict.

Findings table format (no ready-to-paste code):

| Severity | File:Line | Issue | Impact | Fix instruction for Sonnet |
|---|---|---|---|---|

Severity: Critical (tenant leak, security hole, data loss — blocks merge) · High (blocks merge) · Medium (fix in PR or file follow-up) · Low (optional).
Verdict: **Changes requested** or **Approved to merge** (no open Critical/High, CI green).
