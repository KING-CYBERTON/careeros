# Privacy policy

> **Draft for review. Not legal advice. Not in force until approved.**
> Items marked `[TO CONFIRM]` need a decision from the owner or a lawyer before launch.

**Last updated:** `[TO CONFIRM: date of approval]`

This policy explains what personal data CareerOS (the "service") collects, why, who handles it, how long it is kept, and what rights you have. It is written for Kenya's Data Protection Act 2019 and the EU and UK General Data Protection Regulation (GDPR), and we try to give everyone the same basic rights.

## 1. Who is responsible for your data

- **Individuals on the personal plan.** The operator of the service is the controller of your data: `[TO CONFIRM: legal name, registered address]`. Contact: `[TO CONFIRM: privacy contact email]`. `[TO CONFIRM: data protection officer, if one is needed.]` `[TO CONFIRM: registration of the operator as a data controller or processor with the Office of the Data Protection Commissioner (ODPC) in Kenya, and the registration number.]`
- **Members of an organization.** If you use CareerOS through an organization (for example a university or employer) on its own web address, the organization decides why and how your data in its workspace is used. **The organization is the controller** and CareerOS acts for it as a **processor**, under the data processing addendum. For questions about your data in that workspace, contact the organization first. We still handle the account-level and security data needed to run the platform, and we are responsible for that data.

If an organization has linked its own privacy policy on its sign-up page, that policy describes what the organization does with your data. This policy describes what the platform does.

## 2. What data we collect

| Group               | What                                                                                                                                                                                                                                                                                                                                                                                                                                  | Where it comes from                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Account             | Name, username, email address, profile picture (if you add one or sign in with a provider that gives one), time zone from your device, and how you sign in: a password (stored only in a hashed form), passkeys, two-step verification settings, linked sign-in accounts (Google, GitHub, LinkedIn or others that are switched on) and API keys you create.                                                                           | You, and the sign-in provider you choose. |
| Organization        | Which organizations you belong to, your role, invitations sent to your email address, and the organization's name, logo, colours and legal links if you manage them.                                                                                                                                                                                                                                                                  | You, the organization.                    |
| Profile and career  | Your career profile and facts, stories, schedules, saved job opportunities, notes, interview and answer records, and application details.                                                                                                                                                                                                                                                                                             | You, and job pages you choose to save.    |
| Resumes and letters | Resumes, past versions, cover letters, their text and settings, and their view and download counts. Counts do not record who viewed.                                                                                                                                                                                                                                                                                                  | You.                                      |
| Job discovery       | The searches you set up (name, job titles, skills, keywords, locations, remote preference, the company job boards to check and how often), a record of each run (when it ran, counts, and short error codes per board), and the job postings found for you (title, company, location, link, posting text, match scores, and whether you accepted or dismissed it). Dismissed and accepted postings are kept so they do not come back. | You, and public job boards.               |
| Applications        | Applications you track, their stages, notes, dates and attached files.                                                                                                                                                                                                                                                                                                                                                                | You.                                      |
| Uploaded files      | Pictures, imported resume files, attachments and branding images you upload.                                                                                                                                                                                                                                                                                                                                                          | You.                                      |
| AI records          | Assistant conversations, messages and actions, attachments you add to them, reports you file about AI content, and the AI connection you set up (provider, model and an encrypted key). `[TO CONFIRM: AI usage records for plan limits and billing, which are planned and not recorded yet.]`                                                                                                                                         | You, and the AI provider's replies.       |
| Plan and billing    | Your organization's plan, status and an audit log of plan changes. `[TO CONFIRM: payment records, once a payment provider is chosen (D1).]`                                                                                                                                                                                                                                                                                           | You, the organization, us.                |
| Technical           | For each sign-in session: the network (IP) address and browser details (user agent), and when it was created and expires. Short-lived counters of requests per network address that protect the service from abuse. Server logs. `[TO CONFIRM: what the server logs contain, and for how long they are kept.]`                                                                                                                        | Your device.                              |
| Messages            | Emails we send you (sign-in verification, password reset, invitations, notifications) and your email delivery address.                                                                                                                                                                                                                                                                                                                | Us.                                       |

We do not collect more than the service needs, and we do not sell personal data.

The ATS checker reads the PDF you give it in your browser. The file is not uploaded to our servers.

## 3. Why we use it, and our legal basis

| Purpose                                                                                                                           | Basis                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Create and secure your account, run the features you use, store your resumes and applications, send you service emails            | **Contract** (we need it to provide the service you asked for).                                                                     |
| Keep the service safe: stop abuse, limit request rates, investigate misuse, keep audit trails                                     | **Legitimate interest** in security and a working service, balanced against your rights.                                            |
| Meet legal duties, answer lawful requests, keep required records                                                                  | **Legal obligation**.                                                                                                               |
| Send AI requests to an AI provider, save jobs from web pages through the clipper, share a resume publicly, optional notifications | **Consent**, which you give by using the feature. You can withdraw it by stopping the feature, turning it off or deleting the data. |
| Improve the service using counts that do not identify you                                                                         | **Legitimate interest**. `[TO CONFIRM: whether any product analytics will be used.]`                                                |

Under Kenya's Data Protection Act 2019 we use your data only for these purposes, keep it accurate, and do not keep it longer than needed.

When an organization is the controller, the organization decides its own legal basis for its members' data.

## 4. AI features

When you use an AI feature, we send what the request needs (for example part of your resume, a job posting or your message) to an AI provider and show you the reply.

- The provider is either one configured for the platform `[TO CONFIRM: the provider(s) used in production, intended to be the Claude API from Anthropic, and its data retention and training terms]`, or one you connect yourself with your own key. If the platform provides AI, personal connections are not available.
- A key you save is stored encrypted. We show only the first and last few characters back to you.
- If you connect your own provider, that provider's privacy terms apply to what you send it.
- You can turn AI features off by not using them.

## 5. Who else handles your data (processors)

We use other companies to run the service. They act on our instructions. The list below is a template; the names depend on how the service is set up.

| Role                                                                         | Provider                                                                                                      | What they handle                                                                                                                         | Location            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Hosting and servers                                                          | `[TO CONFIRM: hosting provider, pending the production hosting decision (G8)]`                                | All service data                                                                                                                         | `[TO CONFIRM]`      |
| Database                                                                     | `[TO CONFIRM: managed or self-hosted PostgreSQL]`                                                             | Account and workspace data                                                                                                               | `[TO CONFIRM]`      |
| File storage                                                                 | `[TO CONFIRM: storage service]`                                                                               | Uploaded files                                                                                                                           | `[TO CONFIRM]`      |
| Content delivery and network protection                                      | `[TO CONFIRM: for example Cloudflare, if used in production]`                                                 | Web traffic, IP addresses                                                                                                                | `[TO CONFIRM]`      |
| Email sending                                                                | `[TO CONFIRM: email provider]`                                                                                | Your email address and the emails sent                                                                                                   | `[TO CONFIRM]`      |
| AI                                                                           | `[TO CONFIRM: AI provider, intended to be Anthropic for the Claude API]`                                      | Content you send in AI requests                                                                                                          | `[TO CONFIRM]`      |
| Public job boards (job discovery)                                            | Greenhouse, Lever and Ashby `[TO CONFIRM: final list of boards]`                                              | We request a company's public job list by its board name. We send no member data to them, but they can see our server's network address. | Provider's location |
| Web search and page reading for AI (only if you or the operator connect one) | Firecrawl, Tavily or Exa `[TO CONFIRM: which, if any, are used in production]`                                | Search words and web addresses the assistant looks up                                                                                    | `[TO CONFIRM]`      |
| Sign-in providers (only the ones you choose)                                 | Google, GitHub, LinkedIn, Apple or an organization's own single sign-on `[TO CONFIRM: which are switched on]` | Your name, email and picture, when you sign in with them                                                                                 | Provider's location |
| Payments                                                                     | `[TO CONFIRM: payment provider, once decided (D1)]`                                                           | Payment details                                                                                                                          | `[TO CONFIRM]`      |
| Backups                                                                      | `[TO CONFIRM: off-site backup storage, see the backup plan (G9)]`                                             | Encrypted copies of the database and files                                                                                               | `[TO CONFIRM]`      |

We may also share data when the law requires it, to protect people's safety or our rights, or in a sale or restructuring of the business, with notice to you.

If you choose to make a resume public, anyone can see it.

## 6. How we protect it

- Each organization's data is kept apart from other organizations' data inside the database by row-level security, and the application connects with a database role that cannot bypass it.
- Saved AI keys and other stored secrets are encrypted before they are saved.
- Sign-in uses hashed passwords, optional passkeys and two-step verification, and rate limits.
- Data travels over encrypted connections (HTTPS) when the service is deployed behind HTTPS. `[TO CONFIRM: HTTPS at the production host.]`
- Encrypted backups are planned. `[TO CONFIRM: backup schedule and retention once the backup plan (G9) is running.]`

No system is perfectly secure. If a breach puts your data at risk we will tell you and the authorities as the law requires.

## 7. How long we keep it

- Your data stays while your account is open.
- When you delete your account, we delete your resumes, letters, applications, uploaded files and related records. File deletion is retried until it completes. `[TO CONFIRM: how long until backups no longer contain the data (planned: 30 days).]`
- Organization workspaces that only you belonged to are deleted with your account.
- Sign-in sessions expire when you have not used them for a while. `[TO CONFIRM: session length.]`
- Server logs and security records: `[TO CONFIRM: retention period.]`
- Records we must keep by law are kept for as long as the law requires.
- If you belong to an organization, the organization decides what happens to your workspace data when you leave. `[TO CONFIRM: what the organization keeps about a removed member.]`

## 8. Transfers to other countries

Our providers, and AI providers, may handle data outside Kenya and outside your country, for example in `[TO CONFIRM: countries]`. When your data leaves Kenya, the EU or the UK we make sure the transfer is allowed, for example because the country has adequate protection, or through standard contract clauses or another safeguard the law accepts. `[TO CONFIRM: the safeguards actually in place with each provider.]`

## 9. Your rights

Under Kenya's Data Protection Act 2019 and the GDPR you can:

- **access** the personal data we hold about you and get a copy;
- **correct** data that is wrong or incomplete, which you can usually do yourself in the product;
- **delete** your data, which you can do by deleting your account in Settings in a web browser;
- **object** to or **restrict** certain uses, and withdraw consent;
- **portability**: take your data with you. The "Export everything" option in account settings gives you your account details, resumes, cover letters, applications and career records as files;
- not be subject to a decision made only by a machine with legal or similarly serious effect. We do not make such decisions. AI suggestions are for you to review.

To use these rights write to `[TO CONFIRM: privacy contact email]`. We will answer within the time the law sets (`[TO CONFIRM: for example 30 days]`). We may need to confirm who you are first. If you are an organization member, we may pass your request to the organization.

**Complaints.** You can complain to the Office of the Data Protection Commissioner (ODPC) in Kenya, or to the data protection authority where you live (for GDPR, your supervisory authority). We would like the chance to fix the problem first.

## 10. Cookies and similar storage

- The service uses a **session cookie** to keep you signed in and to protect sign-in, plus short-lived cookies used for some sign-in handoffs between a platform address and an organization address, and for access to a password-protected resume.
- It also stores **preferences** such as your language and light or dark theme in cookies on your device.
- We do **not** use advertising cookies or third-party trackers. If we add any in the future we will update this policy and ask for consent where the law requires it. `[TO CONFIRM: whether the production hosting adds website analytics, for example Cloudflare Web Analytics, which would need to be disclosed here.]`
- You can clear cookies in your browser. Signing in will then be needed again.

## 11. Children

The service is not for people under 16. We do not knowingly collect data from them. If you think a child has given us data, contact us and we will delete it. `[TO CONFIRM: minimum age, because Kenya's Data Protection Act has extra rules for children's data (under 18). A lawyer should confirm.]`

## 12. Changes

We may update this policy. For changes that matter we will give notice in the product or by email before they apply `[TO CONFIRM: notice period]`. The date at the top shows when it was last updated.

## 13. Contact

`[TO CONFIRM: operator name, address and privacy contact email.]`
