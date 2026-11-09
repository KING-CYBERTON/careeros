import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";

// CAREEROS (P6-T02): addresses the email provider told us not to mail again. Global (no organization_id): a bounce or a
// complaint is about the address, whichever organization sent the mail. The address itself is never stored, only
// sha256(lower-cased address) as hex. The app role has no privilege on the table and reads and writes it through the
// definer functions `careeros_email_is_suppressed` and `careeros_email_suppress`.

export const EMAIL_SUPPRESSION_REASONS = ["bounce", "complaint"] as const;
export type EmailSuppressionReason = (typeof EMAIL_SUPPRESSION_REASONS)[number];

export const emailSuppression = pg.pgTable(
	"email_suppression",
	{
		emailHash: pg.text("email_hash").notNull().primaryKey(),
		reason: pg.text("reason").notNull(),
		providerEmailId: pg.text("provider_email_id"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		pg.check("email_suppression_hash_check", sql`${t.emailHash} ~ '^[0-9a-f]{64}$'`),
		pg.check("email_suppression_reason_check", sql`${t.reason} in ('bounce', 'complaint')`),
	],
);
