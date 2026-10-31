# Upstream patches

Every upstream file CareerOS modifies is listed here (PRODUCT.md §12). Edits inside upstream files are marked with `CAREEROS:` comments (or a `<!-- CAREEROS -->` block in Markdown). Repo settings changes that affect upstream behaviour are listed too.

| File / setting   | Task   | What changed and why                                                                    | Merge-conflict risk      |
| ---------------- | ------ | --------------------------------------------------------------------------------------- | ------------------------ |
| `AGENTS.md`      | P0-T02 | CareerOS precedence block at top                                                        | Low (top-of-file insert) |
| Actions settings | P0-C01 | upstream workflows disabled, files unchanged                                            | None                     |
| `.env.example`   | P0-Q01 | Appended `CAREEROS_TEST_DATABASE_URL` and `CAREEROS_TEST_APP_DATABASE_URL` placeholders | Low (end-of-file append) |
