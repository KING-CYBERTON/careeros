# Pilot organization onboarding playbook

This is the playbook the CareerOS team follows to set up and support a new customer organization, starting with the pilot organization that the v1.0.0 gate needs (PRODUCT.md §13a item 6). It is a team document, not a customer handout. It was generated from the prompt in [PROMPTS.md](PROMPTS.md#5-pilot-organization-onboarding-playbook) and checked against `develop` on 2026-11-11. Menu labels below are the exact labels in the web app.

Items that depend on an open decision are marked, for example "(open: D2)".

## 0. Read this first: two gaps before a real pilot

1. **There is no screen to create an organization or change its address.** Every user gets a personal workspace at sign-up, with the address slug `u-<id suffix>` and the name "<name>'s workspace". A personal workspace (plan `personal`) has no admin pages. The interim path, to be confirmed on staging before the pilot, is in step 2 below: the platform admin moves the owner's workspace onto a paid plan, which opens the admin pages, and the owner sets the display name through Branding. The address slug still cannot be changed from the app, so a custom domain is the way to give the pilot a clean address. A proper "create organization" and "rename address" flow needs a spec (it is on the STATUS.md watch list).
2. **Billing is not live.** Real prices are not set (open: D2) and Paystack keys are not on staging yet. For the pilot, use a manual payment recorded by a platform admin, or leave billing off.

## 1. Before the setup call

Collect these from the customer and keep them in the pilot record, not in the repository:

- [ ] Organization display name, as it should appear in the app and emails.
- [ ] Preferred web address: a custom domain they control (for example `careers.example.ac.ke`), and someone who can add DNS records.
- [ ] Logo (SVG or PNG) and favicon, brand colours, and font choice.
- [ ] Email sender name and a support link or address.
- [ ] Their own terms and privacy links, if they have them. Otherwise our pages apply (and those are still drafts, open: G10).
- [ ] The owner (one person) and the admins, with email addresses.
- [ ] Expected number of members (seats) and the plan.
- [ ] Cohorts, for example "Class of 2027" or "Spring bootcamp", with start and end dates.
- [ ] Whether anyone with the address may sign up (open sign-up), or invitations only.
- [ ] Which features they care about most, so you can check those first.

## 2. Day 0: platform side

Done by a platform admin on the platform host. You need the admin role (granted with `tooling/careeros/platform-admin.mjs`, see [operations onboarding](operations-onboarding.md)) and two-factor authentication on.

1. Ask the owner to sign up on the platform host with the email they will use. Sign-up creates their workspace and makes them its owner.
2. Open `/admin`, **Organizations**, and find the workspace by the owner's name.
3. Change its plan from `personal` to the agreed plan and set the seats. This opens the admin pages for the owner. Every change writes an audit row with your reason, so write a clear one ("Pilot, agreed with <role> on <date>").
4. If they pay by invoice, record the payment with **Record manual payment** once it arrives.
5. Decide on AI: platform AI comes with the plan's credits. Leave overage off for the pilot unless agreed.
6. Check the organization address resolves: open `https://<slug>-careeros.ayopa.co.ke` on staging. DNS records for new organizations are created automatically within about 10 minutes.

## 3. Day 0: with the owner

Walk the owner through **Settings**. Each page below is visible to owners and admins of a non-personal organization.

1. **Branding.** App name, logo, favicon, colours, font, email sender name, support link, terms and privacy links. The changes show at once on the organization's address, in emails and in the mobile app. This is also where open sign-up is switched on or off.
2. **Domains.** Add the custom domain. The page shows a TXT record to prove ownership and the CNAME target. Once both are in DNS, the domain verifies and gets a certificate through Cloudflare. Custom domains are a plan feature, so the plan from step 2 must include them.
3. **Cohorts.** Create the cohorts with their dates.
4. **Members & invites.** Invite the admins first. Then use bulk invite: upload a CSV with columns `email`, `role` (`member` or `admin`) and `cohort` (a cohort name). At most 500 rows per file. Run the dry run, read the per-row results (duplicates, existing members, unknown cohorts, over the seat limit), then confirm. Rows past the seat limit are reported, never sent.
5. **Org email templates.** Review the four built-in templates (follow-up, thank-you, networking, negotiation) and replace any with the organization's own wording. Members then see them under "Write email" in an application.
6. **Billing** (`/dashboard/organization/billing`). Show the owner the plan, status, seats, period and AI credits. Purchasing through Paystack works only once keys and prices are set (open: D2).

Mobile shows members everything they need, but the admin pages and billing purchase are web-only (decision D10).

## 4. Week 1: watch adoption

Check these with the owner at the end of the first week:

- **Analytics.** Active members, resumes created, applications, interviews and offers, by cohort and date range. Export to CSV if the owner wants to share it internally.
- **AI usage.** Credits used against the pool, by feature and by top members. Members see a notice at 80% and calls stop at 100%.
- **Audit log.** Plan changes, invitations, exports and support sessions.

Step in if fewer than half of the invited members have signed in by the end of the week, if invitations bounce, or if AI credits are on track to run out before the period ends.

## 5. Support sessions

A platform admin can start a **Support session** from the organization's page in `/admin` to see the app as one of the organization's owners (the form lists the owners). Use it only when the owner has asked for help and a screenshot is not enough.

- It needs a reason, lasts at most 60 minutes and runs on the organization's address, with a banner on every page.
- It cannot target another platform admin, and it cannot create lasting credentials (API keys, OAuth clients and tokens) or sign the owner out elsewhere.
- Start and end each write audit rows, in the platform audit and in the organization's own audit log, so its admins can see it.

## 6. Common problems

| Problem                | What the member sees                           | What to do                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain does not verify | Domains page stays pending                     | Check the TXT and CNAME records with the customer's DNS admin; DNS can take time to spread. See the staging runbook, "Test a custom domain"                                 |
| Seat limit reached     | `SEAT_LIMIT_REACHED` on invite, accept or join | Pending invitations hold seats: revoke stale ones, or raise seats in `/admin`                                                                                               |
| Organization suspended | Read-only, `ORG_SUSPENDED` on any write        | Usually a lapsed payment after the 7-day grace period. Record the payment or reactivate in `/admin`, with a reason                                                          |
| AI quota exceeded      | `AI_QUOTA_EXCEEDED`                            | Wait for the next period, add seats (credits grow with seats), or allow overage in `/admin` if agreed                                                                       |
| Feature not in plan    | `FEATURE_NOT_IN_PLAN`                          | Custom domains and job discovery depend on the plan. Change the plan or explain the limit                                                                                   |
| Emails do not arrive   | Nothing in the inbox                           | Check `EMAIL_PROVIDER` is set (otherwise emails are only logged), send a test from `/admin`, Email, and check whether the address is on the suppression list after a bounce |
| Unknown address        | "Not set up yet" page                          | The slug is wrong, or the DNS record has not been created yet (wait 10 minutes)                                                                                             |

## 7. Pilot exit evidence

For the v1.0.0 report, record in the pilot record and summarise in `docs/RELEASE-1.0.0.md`:

- [ ] The organization serves on its own custom domain with valid TLS.
- [ ] Its branding shows on the web app, emails and mobile sign-in.
- [ ] Admins and members were invited and signed in, and at least one cohort is in use.
- [ ] Analytics, AI usage and the audit log show real activity.
- [ ] Any support sessions are in the audit log with reasons.
- [ ] The owner's feedback is written down and turned into questions or specs by Opus.
