# P6-T02a: "Email delivery set up" flag must count Plunk

**Status:** Approved (Opus, 2026-11-09). Bug fix to P6-T02.

## Problem

`flags.smtpEnabled` (packages/api/src/features/flags/router.ts) is computed only from `SMTP_HOST/USER/PASS/FROM`.
With `EMAIL_PROVIDER=plunk` configured, the flag is false, so:

- Settings → Account → Email shows "Email delivery isn't set up on this server, so the address isn't verified." instead of the
  "Not verified yet. Resend the link" button (web `apps/web/src/features/settings/account/profile.tsx`, and the mobile
  equivalent if one exists).
- The interview schedule sheet (web and mobile `schedule-sheet.tsx`) treats email as unavailable.

## Change

1. The flag must be true exactly when `resolveEmailProvider()` in `packages/email/src/transport.ts` would return `"plunk"` or
   `"smtp"`, and false when it returns `"log"`. Keep the api package free of a dependency on `@reactive-resume/email`
   (the existing comment says why): mirror the resolution logic locally in the flags router, reading the same env vars
   (`EMAIL_PROVIDER`, `PLUNK_SECRET_KEY`, `EMAIL_FROM_ADDRESS`, SMTP vars). Add a comment in both places that they must
   stay in step.
2. Keep the wire field name `smtpEnabled` for backward compatibility (old mobile binaries read it). Update its zod
   `.describe()` to "Whether outbound email (SMTP or Plunk) is configured on this instance." Do not add a new field.
3. Mobile parity: check the mobile account/profile screen for the same "isn't set up" copy and confirm it reads the same flag.
   No mobile code change is expected beyond that.
4. Unit tests for the flag computation: plunk complete → true; plunk missing key → false; `EMAIL_PROVIDER=log` with SMTP
   vars → false; `EMAIL_PROVIDER=smtp` with SMTP vars → true; no provider + complete SMTP → true; nothing → false.
5. If `docs/spec.json` / OpenAPI mentions the description, regenerate with `pnpm docs:gen`.

## Out of scope

Renaming the flag, any change to sending.

## Acceptance

- With staging's `EMAIL_PROVIDER=plunk` settings, an unverified user sees "Not verified yet. Resend the link".
- Static, unit and e2e CI green.
