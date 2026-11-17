# Legal documents: improvements after launch

Stephen approved launching the terms, privacy policy and data processing addendum on 17 November 2026, with a minimum age of 18. The items below were filled with reasonable defaults so the pages carry no placeholders. A lawyer should review them, and the owner should confirm the facts, before they are relied on.

## Needs a lawyer

1. **Liability cap** (terms, section on liability): set to fees paid in the 12 months before the claim. Confirm the cap and the wording on indirect loss.
2. **Governing law and courts** (terms, DPA): Republic of Kenya, courts of Nairobi. Consider arbitration.
3. **ODPC registration** (privacy, DPA): Kenya's Data Protection Act may require Ayopa Ltd to register with the Office of the Data Protection Commissioner as a controller and processor. Once registered, add the number to the privacy policy, and say who files what in the DPA.
4. **Data protection officer**: decide whether one is needed and name them.
5. **Transfers outside Kenya** (privacy, DPA): the safeguard used with each provider (Contabo, Cloudflare, Plunk and Amazon SES, Anthropic, Paystack).
6. **Refunds and cancellation** (terms): no refunds for partial periods unless the law requires them. Check this against Kenyan consumer law.
7. **Audit costs** (DPA): the customer pays for audits. Decide whether to offer independent reports.

## Facts to confirm

1. **Plunk and Amazon SES region** (stated as EU and United States).
2. **Paystack processing locations** (stated as Nigeria, Kenya and other countries where Paystack operates).
3. **R2 bucket region** (stated as European Union; check the bucket's location in the Cloudflare dashboard).
4. **Backups** (stated as encrypted, kept in Cloudflare R2 for up to 30 days). Make sure the backup job (G9) is running and that a restore has been tested.
5. **Encryption at rest** on the Contabo server (the DPA says it depends on the host).
6. **Server log retention** (stated as up to 90 days). Set the Docker and log rotation to match.
7. **Session length** (stated as 7 days, the Better Auth default).
8. **Export window after termination** (30 days) and **workspace deletion after an organization's contract ends** (30 days).
9. **Notice periods** for changes to terms, policy and sub-processors (30 days) and **response time** for privacy requests (30 days).
10. **AI provider**: stated as Anthropic's Claude API. If OpenRouter becomes the platform AI provider (P3-T11), add it and its location.
11. **Analytics**: the policy says there is no third-party analytics. If Cloudflare Web Analytics or similar is switched on, disclose it.
12. **What an organization keeps about a removed member**, and whether an organization-wide export will be offered.
13. **Special categories of data** in free text: decide whether the DPA should forbid them as a rule.
