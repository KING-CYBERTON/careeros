# Data processing addendum

> **Draft for review. Not legal advice. Not in force until approved.**

**Last updated:** 17 November 2026

This addendum is for **organizations** that use CareerOS for their members (for example universities, training programmes and employers). It forms part of the agreement between the organization (the "customer") and Ayopa Ltd ("CareerOS", "we"). It applies where CareerOS handles personal data on behalf of the customer. It is written for Kenya's Data Protection Act 2019 and the GDPR. Individuals on the personal plan are covered by the privacy policy, not by this addendum.

## 1. Roles

- The **customer is the controller** of the personal data of its members that is stored in its workspace. It decides why and how that data is used.
- **CareerOS is the processor.** We handle that data only to provide the service to the customer.
- CareerOS is the controller of its own account, security and billing records, as described in the privacy policy.

## 2. What is covered

| Item               | Description                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject matter     | Providing the CareerOS platform to the customer's members: resumes, cover letters, career profiles, applications, job discovery and the clipper, AI assistance, and the customer's branding.                                                                                                                                       |
| Duration           | As long as the customer uses the service, plus the return or deletion period in section 10.                                                                                                                                                                                                                                        |
| Nature and purpose | Storing, displaying, exporting and transforming data; sending requests to an AI provider when a member uses an AI feature; sending emails on the customer's behalf; keeping the platform secure.                                                                                                                                   |
| Categories of data | Name, email address, username, picture, time zone, sign-in and security data, organization role, resume and letter content, work and education history, skills, career facts and notes, job and application records, uploaded files, AI conversations and their content, and session technical data (IP address, browser details). |
| Data subjects      | The customer's members and invitees, and people named in members' content (for example referees).                                                                                                                                                                                                                                  |
| Special categories | The service does not ask for them, but members may include them in free text. The customer should tell members not to.                                                                                                                                                                                                             |

## 3. What CareerOS does and does not do

CareerOS will:

- handle the data **only on the customer's documented instructions**, which are this addendum, the agreement and the customer's use of the service. If we think an instruction breaks the law we will say so;
- make sure the people who can reach the data are **bound by confidentiality**;
- not sell the data, and not use it for our own purposes, including training AI models;
- tell the customer if the law requires us to disclose the data, unless the law forbids us to;
- keep the records the law requires of a processor.

## 4. Security

We use the following measures, which the product applies today:

- **Per-organization isolation.** Each organization's data is kept apart from every other organization's in the database through row-level security. The application connects with a database role that cannot bypass those rules, and tests check that one organization cannot read another's data.
- **Encryption in transit** (HTTPS through Cloudflare).
- **Encrypted secrets.** Saved AI provider keys, web access keys and sign-in provider tokens are encrypted before they are stored. Passwords are stored hashed.
- **Access control.** Sign-in with optional passkeys and two-step verification, roles inside the organization (owner, admin, member), rate limiting, and an audit log of plan changes.
- **Backups.** Nightly encrypted database backups and a copy of stored files to an off-site bucket, kept for 30 days, with a restore drill.
- **Encryption at rest** of the database and file storage depends on the hosting provider.

We review these measures from time to time and may improve them. We will not lower the overall level of protection during the term.

## 5. Sub-processors

The customer allows us to use the sub-processors below. We have a written agreement with each one that requires protection equal to this addendum, and we remain responsible for them.

| Sub-processor                                    | Service              | Data                           | Location                                                 |
| ------------------------------------------------ | -------------------- | ------------------------------ | -------------------------------------------------------- |
| Contabo                                          | Servers and database | All workspace data             | Germany (EU)                                             |
| Contabo (SeaweedFS run by us on the same server) | File storage         | Uploaded files                 | Germany (EU)                                             |
| Cloudflare                                       | Web traffic          | IP addresses, requests         | Global network; Cloudflare, Inc. is in the United States |
| Plunk (sends through Amazon SES)                 | Sending emails       | Email addresses, email content | European Union and United States                         |
| Anthropic (Claude API)                           | AI features          | Content in AI requests         | United States                                            |
| Firecrawl, Tavily or Exa, if connected           | AI web access        | Search words, web addresses    | United States                                            |
| Paystack                                         | Payments             | Billing details                | Nigeria, Kenya and other Paystack countries              |
| Cloudflare R2                                    | Backups              | Encrypted copies of all data   | European Union                                           |

**Changes.** We will tell the customer at least 30 days before adding or replacing a sub-processor, by email to the customer's admin or in the product. The customer may object on reasonable data protection grounds in that time. If we cannot resolve the objection, the customer may end the affected service and receive a refund for the unused period.

## 6. Transfers

Where sub-processors handle data outside Kenya or outside the EU or UK, we will use a transfer mechanism the law accepts, for example an adequacy decision, standard contractual clauses, or another safeguard.

## 7. Helping the customer

- **Data subject requests.** Members can see, correct, export and delete much of their own data in the product. If we receive a request from a member about the customer's workspace, we will pass it to the customer without undue delay and will not answer it ourselves unless told to. We will help the customer answer requests within the time the law allows, for example by exporting or deleting a member's data.
- **Assessments and authorities.** We will give reasonable help with data protection impact assessments and consultations with the Office of the Data Protection Commissioner (ODPC) or another authority.
- **Registration.**

## 8. Personal data breaches

We will tell the customer **without undue delay and in any case within 72 hours** after we become aware of a personal data breach affecting its data. The notice will include what we know about what happened, the data and people affected, the likely effects, and what we have done and will do. We will keep the customer informed and help it meet its own duty to tell the authority and the people affected.

## 9. Audits

The customer may ask for information needed to show that we follow this addendum. We will answer reasonable questions and give summaries of our security measures. The customer may audit us, or appoint an independent auditor, no more than once a year (and after a breach), on reasonable notice, during working hours and under confidentiality, in a way that does not disrupt the service or expose other customers' data. The customer bears the cost of an audit. CareerOS does not currently hold a security certification, such as ISO 27001 or SOC 2, and does not claim one.

## 10. End of the agreement

When the agreement ends, the customer can export its members' data in the formats the product offers (members' own "Export everything" and per-resume downloads). After 30 days we will delete the customer's workspace data, including from live systems, and from backups as they expire in line with our backup retention. On request we will confirm the deletion in writing. We may keep data the law requires us to keep, and will keep protecting it.

## 11. General

- **Liability** under this addendum follows the limits in the agreement.
- **Order of documents.** If this addendum and the agreement conflict about personal data, this addendum wins.
- **Governing law:** the Republic of Kenya.
- **Contact for this addendum:** info@ayopa.co.ke.
