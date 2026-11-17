# Privacy policy

> **Draft for review. Not legal advice. Not in force until approved.**

**Last updated:** 17 November 2026

This policy explains what personal data CareerOS (the "service") collects, why, who handles it, how long it is kept, and what rights you have. It is written for Kenya's Data Protection Act 2019 and the EU and UK General Data Protection Regulation (GDPR), and we try to give everyone the same basic rights.

## 1. Who is responsible for your data

- **Individuals on the personal plan.** The operator of the service is the controller of your data: Ayopa Ltd, Nairobi, Kenya. Contact: info@ayopa.co.ke.
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
| AI records          | Assistant conversations, messages and actions, attachments you add to them, reports you file about AI content, and the AI connection you set up (provider, model and an encrypted key). Counts of AI usage, for plan limits.                                                                                                                                                                                                          | You, and the AI provider's replies.       |
| Plan and billing    | Your organization's plan, status and an audit log of plan changes. Payment records (amount, date, status and a reference) from Paystack. We do not store card numbers; Paystack handles them.                                                                                                                                                                                                                                         | You, the organization, us.                |
| Technical           | For each sign-in session: the network (IP) address and browser details (user agent), and when it was created and expires. Short-lived counters of requests per network address that protect the service from abuse. Server logs (time, address requested, network address and errors).                                                                                                                                                | Your device.                              |
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
| Improve the service using counts that do not identify you                                                                         | **Legitimate interest**. We do not use third-party product analytics.                                                               |

Under Kenya's Data Protection Act 2019 we use your data only for these purposes, keep it accurate, and do not keep it longer than needed.

When an organization is the controller, the organization decides its own legal basis for its members' data.

## 4. AI features

When you use an AI feature, we send what the request needs (for example part of your resume, a job posting or your message) to an AI provider and show you the reply.

- The provider is either one configured for the platform (Anthropic's Claude API, which does not use API data to train its models by default), or one you connect yourself with your own key. If the platform provides AI, personal connections are not available.
- A key you save is stored encrypted. We show only the first and last few characters back to you.
- If you connect your own provider, that provider's privacy terms apply to what you send it.
- You can turn AI features off by not using them.

## 5. Who else handles your data (processors)

We use other companies to run the service. They act on our instructions. The list below is for the service as we run it.

| Role                                                                         | Provider                                                                                   | What they handle                                                                                                                         | Location                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Hosting and servers                                                          | Contabo (virtual private server)                                                           | All service data                                                                                                                         | Germany (EU)                                               |
| Database                                                                     | PostgreSQL that we run ourselves on the Contabo server                                     | Account and workspace data                                                                                                               | Germany (EU)                                               |
| File storage                                                                 | SeaweedFS that we run ourselves on the Contabo server                                      | Uploaded files                                                                                                                           | Germany (EU)                                               |
| Content delivery and network protection                                      | Cloudflare                                                                                 | Web traffic, IP addresses                                                                                                                | Global network; Cloudflare, Inc. is in the United States   |
| Email sending                                                                | Plunk, which sends through Amazon Simple Email Service                                     | Your email address and the emails sent                                                                                                   | European Union and United States                           |
| AI                                                                           | Anthropic (Claude API)                                                                     | Content you send in AI requests                                                                                                          | United States                                              |
| Public job boards (job discovery)                                            | Greenhouse, Lever and Ashby                                                                | We request a company's public job list by its board name. We send no member data to them, but they can see our server's network address. | Provider's location                                        |
| Web search and page reading for AI (only if you or the operator connect one) | Firecrawl, Tavily or Exa                                                                   | Search words and web addresses the assistant looks up                                                                                    | United States                                              |
| Sign-in providers (only the ones you choose)                                 | Google, GitHub, LinkedIn, Apple or an organization's own single sign-on, where switched on | Your name, email and picture, when you sign in with them                                                                                 | Provider's location                                        |
| Payments                                                                     | Paystack                                                                                   | Payment details                                                                                                                          | Nigeria, Kenya and other countries where Paystack operates |
| Backups                                                                      | Cloudflare R2                                                                              | Encrypted copies of the database and files                                                                                               | European Union                                             |

We may also share data when the law requires it, to protect people's safety or our rights, or in a sale or restructuring of the business, with notice to you.

If you choose to make a resume public, anyone can see it.

## 6. How we protect it

- Each organization's data is kept apart from other organizations' data inside the database by row-level security, and the application connects with a database role that cannot bypass it.
- Saved AI keys and other stored secrets are encrypted before they are saved.
- Sign-in uses hashed passwords, optional passkeys and two-step verification, and rate limits.
- Data travels over encrypted connections (HTTPS) (HTTPS).
- Encrypted backups are kept in Cloudflare R2 for up to 30 days.

No system is perfectly secure. If a breach puts your data at risk we will tell you and the authorities as the law requires.

## 7. How long we keep it

- Your data stays while your account is open.
- When you delete your account, we delete your resumes, letters, applications, uploaded files and related records. File deletion is retried until it completes. Backups no longer contain the data after 30 days.
- Organization workspaces that only you belonged to are deleted with your account.
- Sign-in sessions expire when you have not used them for a while (7 days by default).
- Server logs and security records: kept for up to 90 days.
- Records we must keep by law are kept for as long as the law requires.
- If you belong to an organization, the organization decides what happens to your workspace data when you leave.

## 8. Transfers to other countries

Our providers, and AI providers, may handle data outside Kenya and outside your country, for example in the European Union and the United States. When your data leaves Kenya, the EU or the UK we make sure the transfer is allowed, for example because the country has adequate protection, or through standard contract clauses or another safeguard the law accepts.

## 9. Your rights

Under Kenya's Data Protection Act 2019 and the GDPR you can:

- **access** the personal data we hold about you and get a copy;
- **correct** data that is wrong or incomplete, which you can usually do yourself in the product;
- **delete** your data, which you can do by deleting your account in Settings in a web browser;
- **object** to or **restrict** certain uses, and withdraw consent;
- **portability**: take your data with you. The "Export everything" option in account settings gives you your account details, resumes, cover letters, applications and career records as files;
- not be subject to a decision made only by a machine with legal or similarly serious effect. We do not make such decisions. AI suggestions are for you to review.

To use these rights write to info@ayopa.co.ke. We will answer within the time the law sets (within 30 days). We may need to confirm who you are first. If you are an organization member, we may pass your request to the organization.

**Complaints.** You can complain to the Office of the Data Protection Commissioner (ODPC) in Kenya, or to the data protection authority where you live (for GDPR, your supervisory authority). We would like the chance to fix the problem first.

## 10. Cookies and similar storage

- The service uses a **session cookie** to keep you signed in and to protect sign-in, plus short-lived cookies used for some sign-in handoffs between a platform address and an organization address, and for access to a password-protected resume.
- It also stores **preferences** such as your language and light or dark theme in cookies on your device.
- We do **not** use advertising cookies or third-party trackers. If we add any in the future we will update this policy and ask for consent where the law requires it.
- You can clear cookies in your browser. Signing in will then be needed again.

## 11. Children

The service is not for people under 18. We do not knowingly collect data from them. If you think a child has given us data, contact us and we will delete it.

## 12. Changes

We may update this policy. For changes that matter we will give notice in the product or by email at least 30 days before they apply. The date at the top shows when it was last updated.

## 13. Contact

Ayopa Ltd, Nairobi, Kenya. Email: info@ayopa.co.ke
