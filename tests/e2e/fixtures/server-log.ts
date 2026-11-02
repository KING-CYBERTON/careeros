import { readFileSync } from "node:fs";

// CareerOS (P2-Q02): the e2e server has no SMTP, so it logs "SMTP not configured; skipping email send." with the
// recipient and the subject (packages/email/src/transport.ts). playwright.config.ts copies the server's output to
// E2E_SERVER_LOG; this reads the mails back from it. The log has no sender name, body or link in production mode, so
// only the recipient and subject can be checked here (those are covered as unit and integration tests in
// packages/auth/src/email-brand.test.ts and email-links.integration.test.ts). Test-only.

export type LoggedMail = { to: string; subject: string };

// Node prints the logged object as `{ to: '...', subject: '...' }`, switching quote style when the text has a quote.
const MAIL = /to: (['"`])(.*?)\1,\s+subject: (['"`])(.*?)\3/gs;

export function readLoggedMails(): LoggedMail[] {
	const file = process.env.E2E_SERVER_LOG;
	if (!file) throw new Error("E2E_SERVER_LOG is not set; run the specs through playwright.config.ts.");
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		throw new Error(
			`The e2e server log ${file} does not exist. Playwright must start the server itself (not reuse one) for the mail checks.`,
		);
	}
	// Playwright runs the server with colour on, so the logged values arrive wrapped in ANSI escapes.
	// eslint-disable-next-line no-control-regex -- ANSI escape sequences.
	return [...text.replaceAll(/\u001b\[[0-9;]*m/g, "").matchAll(MAIL)].map((match) => ({
		to: match[2] ?? "",
		subject: match[4] ?? "",
	}));
}

/** Waits for the server to log a mail to `to` whose subject starts with `subjectPrefix`. */
export async function waitForLoggedMail(to: string, subjectPrefix: string, timeoutMs = 15_000): Promise<LoggedMail> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = readLoggedMails().find((mail) => mail.to === to && mail.subject.startsWith(subjectPrefix));
		if (found) return found;
		if (Date.now() > deadline)
			throw new Error(
				`No "${subjectPrefix}…" mail to ${to} in the server log. Mails seen for that address: ${JSON.stringify(
					readLoggedMails().filter((mail) => mail.to === to),
				)}`,
			);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}
