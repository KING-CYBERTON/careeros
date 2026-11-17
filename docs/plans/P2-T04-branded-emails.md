# P2-T04: Send every email in the organization's brand

**Status:** Approved (Opus, 2026-11-01). **Thread:** 1 Build. **Phase plan:** [P2-PHASE-PLAN.md](P2-PHASE-PLAN.md), decision D8. **Risks section:** wrong-tenant branding, header injection, links to an unverified host.
**Branch:** `feat/P2-T04-branded-emails`. **Depends on:** T01 (merged), T08 (merged), T03 (#48). Can run in parallel with T02; see requirement 6 for the shared helper.

## Goal

Every email the platform sends carries the brand of the organization it is about: the app name, the logo, the primary colour and a per-org sender display name and reply-to. The sending address stays the platform's verified `SMTP_FROM`. Links in the email lead back to the host the user started on, but only when that host is a verified org host or the platform host. Per-org sending domains are out of scope (Phase 3 or later).

## Requirements

1. **Which organization an email belongs to.** Write one resolver in `packages/auth` (or `packages/api` if the import graph forces it; say which in the PR): `resolveEmailBrandOrg(input)`. It returns an organization id or `null`, and `null` means the platform default.
   - **Invitations:** the inviting organization (`organization.id` from the Better Auth callback).
   - **Verify email, reset password and change-email confirmation:** the org of the request's `HostContext` from T03 when `kind` is `"org"`; otherwise `null`. Better Auth passes the request to these callbacks. If a callback has no request, use `null`. Never pick an org from the user's memberships for these, because a user in two orgs would get one org's brand on the other org's host.
   - **Career notifications** (`sendCareerNotification`, `packages/api/src/features/career/jobs.ts`): the `organization_id` of the row the notification is about. If the job has only the user, use `null` and log a question.
   - **Anything else that sends email:** list each call site in the PR with the org it uses. Run `grep -rn "sendEmail\|sendCareerNotification\|sendMail" packages apps` to find them.
2. **Loading the email branding.** Add a definer function `careeros_email_branding(org_id text)` in a new migration, following the T01 pattern:
   - `SECURITY DEFINER`, `SET search_path = pg_catalog, public`;
   - revoke EXECUTE from PUBLIC, and grant it to `careeros_app` conditionally;
   - it returns the public branding fields plus `email_from_name` and the new `email_reply_to`, and no other columns.
   - Cache the result in-process for 60 seconds per org, and bust the cache on `branding.update` in the same process. If T02 has merged, reuse its cache module rather than adding a second one.
3. **New column `organization_branding.email_reply_to`.** It is nullable `text`, with a CHECK that it looks like one address: no whitespace, no `<`, `>`, `,`, `;` or CR/LF, and exactly one `@`. Add it to the `branding.update` Zod input with the same rule. Only owners and admins can set it, the same as the other fields. The settings UI comes in T07.
4. **Sender and headers.**
   - `from` is `withDisplayName(env.SMTP_FROM, name)`, where `name` is `email_from_name`, else `app_name`, else the platform default. Keep stripping `"`, `\`, CR and LF. Also strip `<`, `>` and any control character, and cap the name at 64 characters.
   - `replyTo` is `email_reply_to` when set. Otherwise leave it out.
   - The career notification `messageId` domain changes from `reactive-resume.local` to a domain derived from `APP_URL`'s hostname. This is a leftover of upstream branding.
5. **Templates** (`packages/email/src/templates/*`):
   - They take a `brand` prop: `{ appName, logoUrl?, primaryColor?, primaryForeground?, supportUrl?, privacyUrl?, termsUrl? }`. This replaces the separate `appName` and `logoUrl` props from T08.
   - The header shows the logo when `logoUrl` is set and the stored logo is PNG or JPEG. Many mail clients block SVG, so for an SVG logo use the app name as text.
   - The action button uses `primaryColor`, with `primaryForeground` for its text.
   - The footer shows the app name and, when set, the support, privacy and terms links.
   - Every template still renders with no brand at all, giving the platform default.
   - Subjects use the app name: for example, "Verify your email for {appName}".
6. **Shared colour helper.** The readable-foreground rule (WCAG contrast; pick black or white text, whichever gives the higher contrast on the primary colour) lives in `packages/utils/src/brand.ts` as `readableForeground(hex)`. If T02 has already added it, reuse it. If T04 lands first, add it there with tests, and T02 reuses it.
7. **Links and logo URLs.**
   - The logo URL is absolute: `<origin>/api/branding-assets/<org>/<file>`, where `<origin>` is the org's verified host origin when there is one, else `APP_URL`.
   - Action links (verify, reset, invite accept) use the origin of the host the flow started on, but only when the `HostContext` says it is the platform host or a verified org host. Anything else falls back to `APP_URL`. Never build a link from the raw `Host` or `X-Forwarded-Host` header.
   - Invitation links go to the inviting org's host when it has one.
   - If Better Auth builds the URL from `baseURL`, rewrite only the origin, and keep the path and token unchanged. Document how, and add a test proving the token survives.
   - Note for T05: per-host sessions mean a verify link must land on the same host that will hold the session. If that needs the auth handoff, keep the `APP_URL` link and log a question for T05 rather than inventing a handoff here.
8. **No personal or secret data in logs.** The dev "SMTP not configured" log may keep printing the rendered email in development, but never in production, which is unchanged. Do not log branding rows.
9. **Upstream patches.** Mark each edit to an upstream file with a `CAREEROS:` comment, and list the files in `docs/UPSTREAM_PATCHES.md`.

## Tests

- Unit (`packages/email`): each template renders with no brand (platform default) and with a full brand (logo, colours, links present). An SVG logo falls back to the text name. An app name containing `<script>`, quotes or CR/LF is escaped in the HTML and stripped from the `From` header.
- Unit (`withDisplayName` and the reply-to logic): a header-injection attempt in `email_from_name` (`"x\r\nBcc: a@b.c"`) produces a single clean header. A reply-to failing the CHECK is rejected by Zod and by the database.
- Unit (resolver): an invitation uses the inviting org. A reset requested on org A's host gets A's brand, even when the user is also a member of B. A reset on the platform host gets the default. A reset with no request gets the default.
- Integration (database): `careeros_email_branding` returns `email_from_name` and `email_reply_to` for the right org only. `careeros_app` can execute it, and PUBLIC cannot. The isolation registry entry for `organization_branding` still passes with the new column.
- Link test: a reset started on a verified org host links to that host with the token unchanged. A forged `X-Forwarded-Host` with `TRUST_FORWARDED_HOST` off links to `APP_URL`.
- e2e is not required here. P2-Q02 covers branded emails end to end through the dev mail log.

## Acceptance

- Every send path is listed in the PR with its org rule, and each one passes the tests above.
- `pnpm --filter @reactive-resume/email test`, auth, api and db tests pass, and lint, format and boundaries are clean.
- CI is green, including e2e.

## Out of scope

Per-org sending domains, DKIM and SPF; custom email templates per org; the settings UI (T07).
