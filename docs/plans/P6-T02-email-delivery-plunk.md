# P6-T02: Email delivery through Plunk

**Status:** Approved (Opus, 2026-11-09). **Thread:** 1 Build. **Decision:** Stephen chose Plunk (hosted), 2026-11-09. **Depends on:** nothing open.
**Branch:** `feat/P6-T02-email-delivery-plunk`. **Questions:** start at Q500.

## What Plunk offers (checked against docs.useplunk.com, 2026-11-09)

- **Send API:** `POST https://next-api.useplunk.com/v1/send`, header `Authorization: Bearer sk_...`, JSON body `to`, `subject`, `body` (HTML; Plunk derives the text part), `from` (`{ name, email }`, domain must be verified), `reply` (reply-to; note: not `replyTo`), `headers`, `subscribed` (default false). Optional `Idempotency-Key` header (24 h, 409 on reuse). Response `{ success, data: { emails: [{ contact, email: <emailId>, status }] } }`. Errors: `{ success: false, error: { code, message, statusCode, requestId } }`; 402 when the plan's monthly cap is hit, 429 when rate-limited (1000 requests/min per project).
- **Hosted Plunk has no documented SMTP relay**, so the existing nodemailer path cannot be reused. This task adds an HTTP transport.
- **Domains:** 3 DKIM CNAMEs, 1 SPF TXT (merge with any existing SPF), 1 feedback MX, optional DMARC and MAIL FROM. Values come from the Plunk dashboard.
- **Events:** only through a workflow "Webhook" step (trigger `email.bounce`, `email.complaint`, `email.delivery`). **No signature**; the documented protection is a static secret header. No retries; 10 s timeout.
- **Templates stored in Plunk are not used.** Our templates stay in `packages/email` (versioned, branded, tested).

## Goal

Every email the platform sends today (verification, password reset, email change, invitations, sign-in links, career notifications, billing renewal reminders) is delivered through Plunk, with the right brand per email, and addresses that hard-bounce or complain are not mailed again.

## The three sender levels (Stephen, 2026-11-09)

One verified sending domain for all of them; only the display name, reply-to and template brand change.

| Level            | Emails                                                                                                    | From name                        | Reply-to                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------- |
| Platform         | Super admin and platform notices                                                                          | Platform app name                | none                                            |
| Organization     | Invitations, sign-in and auth emails on an org host, career notifications, renewal reminders to the owner | `organization_branding.app_name` | `organization_branding.email_reply_to` when set |
| Personal account | Auth and plan emails for personal workspaces                                                              | Platform app name                | none                                            |

The existing code already resolves `fromName` and `replyTo` from branding (P2-T04, P2-T08); keep that logic and only change the transport. Per-org sending domains are out of scope (after v1).

## Requirements

1. **Transport selection** in `packages/email/src/transport.ts`:
   - New env `EMAIL_PROVIDER` = `plunk` | `smtp` | `log`. Default: `smtp` when the `SMTP_*` vars are complete (unchanged upstream behaviour), else `log`.
   - New env for plunk: `PLUNK_SECRET_KEY` (required when provider is plunk; must start with `sk_`), `PLUNK_API_URL` (default `https://next-api.useplunk.com`), `EMAIL_FROM_ADDRESS` (the verified address, for example `no-reply@ayopa.co.ke`; required for plunk). Add all to `packages/env/src/server.ts` with tests, `.env.example` and `infra/staging/.env.staging.example` (placeholders only), and turbo.json pass-through and test env lists.
   - `sendEmail` and `sendCareerNotification` keep their signatures and behaviour (log-only when unconfigured, never log career content, never log credentials). Under plunk they render HTML with `react-email` as today and call the Plunk client.
2. **Plunk client** `packages/email/src/plunk.ts`: typed `fetch` wrapper with a 10 s timeout, `Idempotency-Key` per message (sha256 of a stable key: for career notifications the existing `key`, otherwise a random UUID), `subscribed: false`, `from: { name, email }` built from the cleaned display name and `EMAIL_FROM_ADDRESS`, `reply` only when `safeReplyTo` passes. Header-injection guards stay (subject and names cleaned). Map 402, 429 and 5xx to a typed error; never include the request body or key in errors or logs (log status, Plunk `requestId` and error code only). No retries on send.
3. **Suppression list:** new global table `email_suppression` (`email_hash` = sha256 of the lower-cased address, `reason` `bounce` | `complaint`, `provider_email_id`, `created_at`). No raw address stored. The app role reads it only through a SECURITY DEFINER function `careeros_email_is_suppressed(hash)` and writes only through `careeros_email_suppress(hash, reason, provider_email_id)`, both with `search_path = pg_catalog, public`. Isolation registry entry as global, migration with `down.sql`. `sendEmail` skips suppressed recipients (log "suppressed", no address). Transient bounces are not suppressed.
4. **Event webhook** `POST /api/email/webhook/plunk` in `apps/server`:
   - Auth: header `x-careeros-webhook-secret` compared in constant time to new env `PLUNK_WEBHOOK_SECRET` (required for plunk, at least 32 chars). Missing or wrong: 401, nothing parsed.
   - Body limit 64 KB. Accept the Plunk workflow payload; act on `email.bounce` with `bounceType: "Permanent"` and on `email.complaint`; everything else returns 200 and does nothing. Read the address from `contact.email`, hash it, call the suppress function. Answer 200 within the 10 s budget.
   - Add the route to the public route inventory and its test, with a rate limit like the billing webhook.
5. **Admin test send:** super admin console (platform host only) gains "Send test email" that sends a fixed template to the signed-in admin's own address and shows the provider result (queued or the error code). Audited with `careeros_audit_platform` (a non-`admin.*` action name, per Q422). No recipient input: it only mails the admin themself.
6. **Docs:** `docs/self-hosting/environment-variables.mdx` (Plunk section: env, DNS records, how to create the workflow with the Webhook step and the secret header) and `infra/staging/README.md` (staging setup steps). CHANGELOG line. UPSTREAM_PATCHES rows for every upstream file touched, each marked `CAREEROS:`.

## Acceptance

- Unit tests for the client (request shape incl. `reply` and `from` object, idempotency key, error mapping without leaking body or key), env validation, provider selection, suppression skip.
- Integration test (isolated Postgres): webhook with wrong or missing secret is 401 and writes nothing; a permanent bounce suppresses; a transient bounce does not; complaint suppresses; the app role cannot read or write `email_suppression` directly.
- Existing auth, invitation, career-notification and billing-reminder tests still pass under `log` and `smtp`.
- No real network in tests. No secrets in the repo.

## Out of scope

Per-org sending domains, marketing email, Plunk-stored templates, inbound email, the member-facing email templates (P5-T04).
