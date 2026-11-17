import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { sendTestEmail } from "@reactive-resume/email/test-send";

// CAREEROS (P6-T02): the Super Admin console's "Send test email". It mails the signed-in admin themself and nobody
// else: the address is the session user's, taken by the router from the session, and there is no recipient input. The
// outcome (queued, or the error code) is returned for the page to show and written to the platform audit log.
// The audit row uses the action `email.test_sent`, not an `admin.*` name: `careeros_audit_platform` refuses those (Q422).
// It holds the provider, the outcome and the error code, never an address.

export type TestEmailOutcome = {
	provider: "plunk" | "smtp" | "log";
	outcome: "queued" | "suppressed" | "logged" | "failed";
	code?: string | undefined;
	status?: number | undefined;
};

export async function sendTestEmailToAdmin(actorUserId: string, adminEmail: string): Promise<TestEmailOutcome> {
	const result = await sendTestEmail(adminEmail);
	const outcome: TestEmailOutcome = {
		provider: result.provider,
		outcome: result.outcome,
		...(result.code && { code: result.code }),
		...(result.status !== undefined && { status: result.status }),
	};
	await db.execute(
		sql`select careeros_audit_platform(${actorUserId}::text, null, 'email.test_sent', 'user', ${actorUserId}::text, ${JSON.stringify(outcome)}::jsonb, null)`,
	);
	return outcome;
}
