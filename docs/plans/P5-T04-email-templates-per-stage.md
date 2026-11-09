# P5-T04: Email templates per stage

**Status:** Approved (Opus, 2026-11-09). **Thread:** 1 Build. **Source:** PRODUCT.md §4 "Email Templates per Stage" (P1), §6.2 `email_template`. Stephen asked for it with P6-T02 on 2026-11-09.
**Branch:** `feat/P5-T04-email-templates`. **Questions:** start at Q520. **Parallel with:** P6-T02 (no shared files except docs, UPSTREAM_PATCHES and CHANGELOG).

## Goal

A member writing to an employer picks a template for the application's stage (follow-up, thank-you, networking, negotiation), sees it filled in from the application, edits it, and sends it **from their own mail client** (or copies it). Org admins customise the defaults their members see. The platform never sends these emails.

## Requirements

1. **Schema** `email_template` (tenant table): `id`, `organization_id`, `user_id` (null = org default), `kind` (`follow_up` | `thank_you` | `networking` | `negotiation` | `custom`), `stage_category` (nullable; the application stage categories the template suggests itself for), `name`, `subject`, `body` (plain text, max 10 000 chars), `archived_at`, timestamps. RLS enabled and forced with `tenant_isolation`; a member reads org defaults and only their own rows; only org owners/admins write org defaults. Isolation registry and fuzz inventory entries, `down.sql`.
2. **Built-in defaults:** four CareerOS-written templates (one per kind) shipped as constants in a domain package (not copied from any other product), translated with Lingui. Shown when the org has not customised that kind. An org default with the same kind replaces the built-in for its members.
3. **Variables:** `{{firstName}}`, `{{fullName}}`, `{{company}}`, `{{role}}`, `{{contactName}}`, `{{interviewDate}}`, `{{myEmail}}`. A pure renderer in `packages/resume` or a new small domain package: unknown variables stay as typed, missing values become a visible placeholder like `[company]`, no HTML, no code execution. Unit tests.
4. **API** (`packages/api/src/features/email-templates`, `protectedProcedure`, org from tenant context only): `list` (built-ins + org defaults + mine, with `source`), `create`/`update`/`archive` for my own, `orgCreate`/`orgUpdate`/`orgArchive` for owners/admins (403 otherwise; audit row per change, counts and ids only), `render` (template id + application id → subject and body; the application must be the caller's). Add to the cross-org inventory.
5. **Member UI, web and mobile (parity):** in the application workspace, a "Write email" action (Messages tab and the context column) opens a sheet: template picker filtered by the application's stage, filled preview, editable subject and body, buttons **Open in mail app** (`mailto:` with the contact's email when known, subject and body URL-encoded; fall back to copy when the URL would exceed 1 800 chars) and **Copy**. "Save as my template". Settings → Email templates lists my templates.
6. **Org admin UI:** org admin console → "Email templates": list built-ins and org defaults, edit a default (starts from the built-in text), archive to fall back to the built-in. Mobile: read-only list for admins, matching how mobile treats other org-admin screens; record the parity note in `.agents/docs/mobile-release-handoff.md` if editing stays web-only.
7. **Docs:** a user guide (`docs/guides/writing-employer-emails.mdx`) and the org-admin guide section, with fictional screenshots per the career-platform guide rules. `pnpm lingui:extract`. CHANGELOG, UPSTREAM_PATCHES.

## Acceptance

- Unit: renderer, built-in fallback order (mine → org default → built-in), mailto length fallback.
- Integration: member cannot write org defaults; member cannot read another member's templates; cross-org reads return nothing; `render` refuses another user's application.
- e2e (web): member writes a thank-you from an application and the mailto link carries the filled subject; an org admin edits the follow-up default and a member sees it.
- Mobile test for the sheet's copy and open actions.

## Out of scope

Sending through the platform, tracking opens, AI drafting of these emails (the coach already drafts messages), attachments.
