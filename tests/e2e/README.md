# E2E Tests

This project uses Playwright for PR-gated browser coverage of deterministic core flows.

## Local setup

Install Poppler (`brew install poppler` on macOS or `sudo apt-get install poppler-utils` on Debian/Ubuntu). The browser PDF download test uses `pdftotext` to verify logical Unicode text, including `/ActualText` spans.

Start PostgreSQL:

`sudo docker compose -f compose.dev.yml up -d postgres`

Generate local test secrets:

`export AUTH_SECRET=$(openssl rand -hex 32)`

`export ENCRYPTION_SECRET=$(openssl rand -hex 32)`

Run database migrations:

`APP_URL=http://localhost:3000 PORT=3000 DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres FLAG_DISABLE_SIGNUPS=false FLAG_DISABLE_EMAIL_AUTH=false FLAG_ENABLE_GUEST_LOGIN=true FLAG_DISABLE_API_RATE_LIMIT=true LOCAL_STORAGE_PATH=/workspace/data/e2e pnpm db:migrate`

Build the production app:

`APP_URL=http://localhost:3000 PORT=3000 DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres FLAG_DISABLE_SIGNUPS=false FLAG_DISABLE_EMAIL_AUTH=false FLAG_ENABLE_GUEST_LOGIN=true FLAG_DISABLE_API_RATE_LIMIT=true LOCAL_STORAGE_PATH=/workspace/data/e2e pnpm build`

Run tests:

`APP_URL=http://localhost:3000 PORT=3000 DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres FLAG_DISABLE_SIGNUPS=false FLAG_DISABLE_EMAIL_AUTH=false FLAG_ENABLE_GUEST_LOGIN=true FLAG_DISABLE_API_RATE_LIMIT=true FLAG_ALLOW_UNSAFE_AI_BASE_URL=true LOCAL_STORAGE_PATH=/workspace/data/e2e pnpm test:e2e`

CI runs browser tests independently from unit tests, with four Playwright workers on 32-vCPU Blacksmith runners
and one on GitHub runners. Each test owns its account and browser context; provider fixtures use ephemeral ports.
To compare locally, append `--workers=1` or `--workers=4` to the test command against the same disposable database
and production build. The runner still uses zero retries, so parallelism cannot hide a failed test.

## Coverage

- Email/password sign-up, sign-out and sign-in through the UI.
- Guest login, and a guest's resume carried over when they create an account. Skips without `FLAG_ENABLE_GUEST_LOGIN=true`.
- Builder section editing, with autosave across reloads and a draft kept when saving during navigation fails.
- JSON export/import through the New dialog, including an older file whose resume still carries a cover letter.
- Public sharing: an anonymous visitor's PDF download and statistics, a renamed address that keeps redirecting, and
  a password-protected link.
- OAuth consent for MCP clients: deny, allow with PKCE, and the access token's audience at `/mcp`.
- The assistant, against a scripted OpenAI-compatible provider (`fixtures/ai-stub.ts`). It needs `FLAG_ALLOW_UNSAFE_AI_BASE_URL=true` so the server may call the stub on 127.0.0.1, and skips without it.
- CareerOS billing (`careeros-billing.spec.ts`), against the fake payment provider. It needs `BILLING_PROVIDER=fake`, a `BILLING_FAKE_SECRET` of 16+ characters and `FLAG_ALLOW_FAKE_BILLING=true` (the built server runs with `NODE_ENV=production`, which refuses the fake provider without the flag). Never set the flag on a public deployment. It skips without `BILLING_PROVIDER=fake`.

Visual regression, PDF/DOCX rasterization parity, thumbnail resolution, and import-fixture reproduction are
intentionally outside the PR gate to keep it fast.

<!-- CAREEROS: P1-Q07 -->

## Raw database seeding

Specs that insert or poll tenant rows directly (cover letters, career opportunities, AI reports) use `tests/e2e/fixtures/seed-db.ts`. It connects as the owner role, because the application role is subject to row level security. The URL is `E2E_SEED_DATABASE_URL`, else `DATABASE_MIGRATION_URL`, else `DATABASE_URL` (fine for single-role local setups). Test-only; never use it in application code.

<!-- CAREEROS: P2-Q01, P2-Q02 -->

## Organization hosts

`careeros-auth-handoff`, `careeros-host-isolation` and `careeros-branding` (and the org-host pass of `cross-org-id-fuzz`) reach the app on organization hosts. The server needs `ORG_HOST_PATTERN={slug}.orgs.test` (the CI e2e job sets it); no e2e host on localhost matches it, so every other spec is unaffected. API checks send a `Host` header; browser checks launch Chromium with `--host-resolver-rules=MAP *.orgs.test 127.0.0.1`. The shared helpers are in `tests/e2e/fixtures/org-hosts.ts`, and the branding PNGs in `tests/e2e/fixtures/branding/`.

- `careeros-host-isolation`: a session from A's host cannot read or change B on B's host, an API key bound to A is refused on B, an unknown organization host answers 404 with noindex, a pending custom domain does not resolve.
- `careeros-branding`: each of two organizations shows its own name, logo, accent colour, title, favicon, public resume page and password-reset email subject, and nothing of the other organization.
- Emails: the e2e server has no SMTP, so `playwright.config.ts` copies the server's output to `E2E_SERVER_LOG` (default `<tmpdir>/careeros-e2e-server.log`) and `fixtures/server-log.ts` reads the logged recipient and subject. A server that Playwright did not start itself (`reuseExistingServer`) does not write that file.
