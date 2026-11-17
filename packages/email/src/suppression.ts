import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";

// CAREEROS (P6-T02): the suppression list. An address that hard-bounced or complained is never mailed again. The list is
// global and holds only sha256(lower-cased address); the app role reaches it through two definer functions and has no
// privilege on the table. Called from the server (the webhook) and from `sendEmail`.

export type SuppressionReason = "bounce" | "complaint";

/** sha256 of the trimmed, lower-cased address, as hex. The only form in which an address reaches the table. */
export const hashEmail = (address: string): string =>
	createHash("sha256").update(address.trim().toLowerCase()).digest("hex");

export async function isEmailSuppressed(address: string): Promise<boolean> {
	const { rows } = await db.execute<{ suppressed: boolean }>(
		sql`select careeros_email_is_suppressed(${hashEmail(address)}) as suppressed`,
	);
	return rows[0]?.suppressed === true;
}

export async function suppressEmail(
	address: string,
	reason: SuppressionReason,
	providerEmailId?: string | null,
): Promise<void> {
	await db.execute(
		sql`select careeros_email_suppress(${hashEmail(address)}, ${reason}, ${providerEmailId ?? null}::text)`,
	);
}
