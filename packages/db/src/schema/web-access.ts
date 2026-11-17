import * as pg from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

/** One selected web connection per user. CAREEROS: per organization since P1-T09 (key is `(organization_id, user_id)`). */
export const webAccessCredential = pg.pgTable(
	"web_access_credentials",
	{
		// CAREEROS: tenant column (P1-T09, D11). Row-level security keys on it; writes set it from `requireOrgId()`.
		organizationId: pg
			.text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		provider: pg.text("provider", { enum: ["firecrawl", "tavily", "exa"] }).notNull(),
		encryptedApiKey: pg.text("encrypted_api_key").notNull(),
	},
	(t) => [pg.primaryKey({ columns: [t.organizationId, t.userId] })],
);
