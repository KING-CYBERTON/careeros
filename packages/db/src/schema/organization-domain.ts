import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

/**
 * CAREEROS (P2-T06, phase plan D3, D7): the statuses of an organization custom domain.
 *
 * - `pending`: added; waiting for the TXT record that proves the owner controls the name.
 * - `verified`: the TXT matched; the hostname is registered with Cloudflare for SaaS, which is issuing the certificate.
 * - `active`: Cloudflare reports the hostname and its certificate active. The only status that resolves to the organization.
 * - `failed`: stopped resolving (verification timed out, Cloudflare refused, or the owner moved the name away).
 * - `removing`: the owner removed it; it no longer resolves, and the Cloudflare hostname is being deleted.
 */
export const ORGANIZATION_DOMAIN_STATUSES = ["pending", "verified", "active", "failed", "removing"] as const;
export type OrganizationDomainStatus = (typeof ORGANIZATION_DOMAIN_STATUSES)[number];

/** At most this many domains per organization; the claim function enforces it too. */
export const ORGANIZATION_DOMAIN_LIMIT = 5;

const statusList = sql.raw(ORGANIZATION_DOMAIN_STATUSES.map((status) => `'${status}'`).join(", "));

/**
 * CAREEROS (P2-T06): a domain an organization serves the product on, such as `careers.acme.com`. Tenant-scoped with
 * row level security. Unverified claims to one hostname may coexist, across organizations and users. A hostname that
 * has been PROVEN (`verified`, `active` or `removing`) has exactly one owner across this table and the verified rows of
 * the per-user `custom_domain` table: a global partial unique index, plus a trigger for the cross-table rule.
 */
export const organizationDomain = pg.pgTable(
	"organization_domain",
	{
		id: pg.text("id").notNull().primaryKey(),
		organizationId: pg
			.text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** Normalized: lower case ASCII (punycode), no trailing dot. */
		hostname: pg.text("hostname").notNull(),
		status: pg.text("status").notNull().default("pending"),
		/** The value the owner publishes at `_careeros-verify.<hostname>`: random, 128 bits. */
		verificationToken: pg.text("verification_token").notNull(),
		cfCustomHostnameId: pg.text("cf_custom_hostname_id"),
		cfSslStatus: pg.text("cf_ssl_status"),
		/** Also the lease of the polling job: a pass takes a row by moving this forward. Database time. */
		lastCheckedAt: pg.timestamp("last_checked_at", { withTimezone: true }),
		verifiedAt: pg.timestamp("verified_at", { withTimezone: true }),
		/** A short code (`verification_timeout`, `txt_missing`, `cloudflare_rejected`, ...), never provider text. */
		failureReason: pg.text("failure_reason"),
		/** How many daily checks in a row found the TXT record gone (takeover guard: 3 fails the domain). */
		txtMissingCount: pg.smallint("txt_missing_count").notNull().default(0),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		createdBy: pg.text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(t) => [
		// Several organizations may hold the same UNVERIFIED claim; the first to prove control wins (Q121). Only proven
		// rows are unique. The cross-table rule (against verified custom_domain rows) is the
		// careeros_organization_domain_guard trigger.
		pg.index("organization_domain_hostname_idx").on(t.hostname),
		pg.uniqueIndex("organization_domain_org_hostname_key").on(t.organizationId, t.hostname),
		pg
			.uniqueIndex("organization_domain_proven_hostname_key")
			.on(t.hostname)
			.where(sql`${t.status} in ('verified', 'active', 'removing')`),
		pg.index("organization_domain_org_created_idx").on(t.organizationId, t.createdAt),
		pg.index("organization_domain_status_checked_idx").on(t.status, t.lastCheckedAt),
		pg.check("organization_domain_status_check", sql`${t.status} in (${statusList})`),
		pg.check("organization_domain_hostname_check", sql`${t.hostname} = lower(${t.hostname})`),
	],
);

/**
 * CAREEROS (P2-T06): Cloudflare custom hostnames whose organization (and so its row) is gone. A trigger fills it when
 * an `organization_domain` row that still names a Cloudflare hostname is deleted (an organization delete cascades);
 * the polling job deletes the hostname at Cloudflare and then the row. Platform-global like the storage cleanup
 * sentinel: it holds an opaque Cloudflare id and a host name, no tenant data.
 */
export const organizationDomainCfCleanup = pg.pgTable("organization_domain_cf_cleanup", {
	cfCustomHostnameId: pg.text("cf_custom_hostname_id").notNull().primaryKey(),
	hostname: pg.text("hostname").notNull(),
	attempts: pg.integer("attempts").notNull().default(0),
	nextAttemptAt: pg.timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
	createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
