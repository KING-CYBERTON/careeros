import { withOrgContext, bustHostCache } from "@careeros/tenancy";
import { and, eq, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { CloudflareError, getCloudflareClient, type CloudflareClient, type CustomHostname } from "./cloudflare";
import { checkTxtProof } from "./dns";

// CAREEROS (P2-T06, phase plan D3, D7, D9): the status machine of an organization custom domain.
//
//   pending ──TXT proves ownership──▶ verified ──Cloudflare: hostname and certificate active──▶ active
//      │                                 │                                                        │
//      └─ 7 days without proof ──┐       └─ Cloudflare refuses / certificate times out ──┐        ├─ TXT gone on 3 daily checks
//                                ▼                                                       ▼        ├─ Cloudflare: moved / deleted / blocked
//                              failed ◀──────────────────────────────────────────────────┴────────┘
//   any status ──owner removes──▶ removing ──Cloudflare hostname deleted──▶ (row deleted)
//
// Only `active` resolves to the organization. Every transition is a compare-and-set on the status the check started
// from, so a removal that lands during a check is never undone. DNS and Cloudflare are called outside the database
// scope; each database step is its own `withOrgContext`.

export type OrganizationDomainRow = typeof schema.organizationDomain.$inferSelect;
const table = schema.organizationDomain;

export type ProcessDeps = {
	/** `null` when Cloudflare for SaaS is not configured: nothing is checked or called. */
	cloudflare: CloudflareClient | null;
	checkTxt: (hostname: string, token: string) => Promise<"proved" | "missing" | "unknown">;
};

export const defaultProcessDeps = (): ProcessDeps => ({
	cloudflare: getCloudflareClient(),
	checkTxt: (hostname, token) => checkTxtProof(hostname, token),
});

/** Daily checks in a row that may find the TXT record gone before an active domain stops resolving. */
export const TXT_MISSING_LIMIT = 3;

type Failure =
	| "verification_timeout"
	| "cloudflare_rejected"
	| "cloudflare_moved"
	| "cloudflare_deleted"
	| "txt_missing";

const HOSTNAME_FAILED = new Set(["blocked", "deleted", "pending_deletion"]);
const SSL_FAILED = new Set(["deleted", "pending_deletion", "expired"]);
const sslFailed = (status: string | null) =>
	status !== null && (SSL_FAILED.has(status) || status.endsWith("_timed_out"));
const cloudflareActive = (cf: CustomHostname) => cf.status === "active" && cf.sslStatus === "active";

/** The action in force after a status change: the host cache must not keep answering for the old status. */
const dropCached = (hostname: string) => bustHostCache({ hostname });

type Mode = "job" | "manual";

/**
 * Takes a row for a check by moving `last_checked_at` to the database's now, in one statement: another server instance
 * running the same pass cannot take it again until the interval has passed. The job's interval is 5 minutes (24 hours
 * for an active domain); a manual recheck needs one minute since the last check, whoever made it.
 */
async function lease(id: string, mode: Mode): Promise<(OrganizationDomainRow & { timedOut: boolean }) | undefined> {
	const due =
		mode === "manual"
			? and(
					inArray(table.status, ["pending", "verified", "active"]),
					or(isNull(table.lastCheckedAt), lte(table.lastCheckedAt, sql`now() - interval '1 minute'`)),
				)
			: or(
					and(
						inArray(table.status, ["pending", "verified", "removing"]),
						or(isNull(table.lastCheckedAt), lte(table.lastCheckedAt, sql`now() - interval '5 minutes'`)),
					),
					and(
						eq(table.status, "active"),
						or(isNull(table.lastCheckedAt), lte(table.lastCheckedAt, sql`now() - interval '24 hours'`)),
					),
				);
	const [row] = await db
		.update(table)
		.set({ lastCheckedAt: sql`now()` })
		.where(and(eq(table.id, id), due))
		.returning({
			id: table.id,
			organizationId: table.organizationId,
			hostname: table.hostname,
			status: table.status,
			verificationToken: table.verificationToken,
			cfCustomHostnameId: table.cfCustomHostnameId,
			cfSslStatus: table.cfSslStatus,
			lastCheckedAt: table.lastCheckedAt,
			verifiedAt: table.verifiedAt,
			failureReason: table.failureReason,
			txtMissingCount: table.txtMissingCount,
			createdAt: table.createdAt,
			createdBy: table.createdBy,
			timedOut: sql<boolean>`${table.createdAt} <= now() - interval '7 days'`,
		});
	return row;
}

type Change = { [K in keyof typeof table.$inferInsert]?: (typeof table.$inferInsert)[K] | SQL };

/** Compare-and-set: applies `change` only while the row still has the status the check started from. */
async function transition(
	orgId: string,
	row: OrganizationDomainRow,
	from: OrganizationDomainRow["status"],
	change: Change,
): Promise<OrganizationDomainRow | undefined> {
	const [updated] = await withOrgContext(orgId, () =>
		db
			.update(table)
			.set(change)
			.where(and(eq(table.id, row.id), eq(table.status, from)))
			.returning(),
	);
	// Resolution depends on the status, so any change drops the cached answer for this host (this process; others
	// follow within the cache's 60 seconds).
	if (updated && (updated.status !== from || from === "active")) dropCached(row.hostname);
	return updated;
}

const fail = (reason: Failure): Change => ({ status: "failed", failureReason: reason });

async function reread(orgId: string, id: string): Promise<OrganizationDomainRow | undefined> {
	const [row] = await withOrgContext(orgId, () => db.select().from(table).where(eq(table.id, id)).limit(1));
	return row;
}

/** Cloudflare accepted the hostname after we lost the row (removed mid-check): delete it, or queue it for the job. */
async function abandonCloudflareHostname(cloudflare: CloudflareClient, cf: CustomHostname) {
	try {
		await cloudflare.delete(cf.id);
	} catch {
		await db
			.insert(schema.organizationDomainCfCleanup)
			.values({ cfCustomHostnameId: cf.id, hostname: cf.hostname })
			.onConflictDoNothing();
	}
}

/** Registers the hostname with Cloudflare, or adopts the one a crashed earlier attempt left in the zone. */
async function createOrAdopt(cloudflare: CloudflareClient, hostname: string): Promise<CustomHostname | undefined> {
	try {
		return await cloudflare.create(hostname);
	} catch (error) {
		if (!(error instanceof CloudflareError) || !error.isDuplicate) throw error;
	}
	const existing = await cloudflare.find(hostname);
	if (!existing) return undefined;
	// A hostname queued for deletion belongs to an organization that is gone: wait until it has been deleted.
	const [queued] = await db
		.select({ id: schema.organizationDomainCfCleanup.cfCustomHostnameId })
		.from(schema.organizationDomainCfCleanup)
		.where(eq(schema.organizationDomainCfCleanup.cfCustomHostnameId, existing.id))
		.limit(1);
	return queued ? undefined : existing;
}

/** The TXT matched: register the hostname with Cloudflare and follow its status until it is active. */
async function progressVerified(orgId: string, row: OrganizationDomainRow, deps: ProcessDeps) {
	const cloudflare = deps.cloudflare;
	if (!cloudflare) return;
	let cf: CustomHostname | undefined;
	try {
		if (row.cfCustomHostnameId) {
			cf = await cloudflare.get(row.cfCustomHostnameId);
		} else {
			cf = await createOrAdopt(cloudflare, row.hostname);
			if (!cf) return;
			const saved = await transition(orgId, row, "verified", { cfCustomHostnameId: cf.id, cfSslStatus: cf.sslStatus });
			if (!saved) {
				await abandonCloudflareHostname(cloudflare, cf);
				return;
			}
		}
	} catch (error) {
		if (!(error instanceof CloudflareError)) throw error;
		// Deleted at Cloudflare behind our back: forget the id so the next pass registers it again.
		if (row.cfCustomHostnameId && error.isNotFound)
			await transition(orgId, row, "verified", { cfCustomHostnameId: null, cfSslStatus: null });
		// Anything else (network, 5xx, rate limit, a refused request) is logged by the client and retried next pass.
		return;
	}
	if (cloudflareActive(cf)) {
		await transition(orgId, row, "verified", { status: "active", cfSslStatus: cf.sslStatus, txtMissingCount: 0 });
	} else if (HOSTNAME_FAILED.has(cf.status) || sslFailed(cf.sslStatus)) {
		await transition(orgId, row, "verified", { ...fail("cloudflare_rejected"), cfSslStatus: cf.sslStatus });
	} else if (cf.sslStatus !== row.cfSslStatus) {
		await transition(orgId, row, "verified", { cfSslStatus: cf.sslStatus });
	}
}

/**
 * The takeover guard (phase plan D3): an active domain whose owner moved it away must not keep pointing at the
 * organization. The TXT proof must still be there on 3 daily checks in a row, and Cloudflare must still know the
 * hostname. A lookup that failed (timeout, SERVFAIL) is not a missing record and changes nothing. A manual recheck
 * refreshes Cloudflare's status but does not count TXT checks: only the daily cadence may fail a domain.
 */
async function checkActive(orgId: string, row: OrganizationDomainRow, mode: Mode, deps: ProcessDeps) {
	let misses = row.txtMissingCount;
	if (mode === "job") {
		const proof = await deps.checkTxt(row.hostname, row.verificationToken);
		if (proof === "proved") misses = 0;
		else if (proof === "missing") misses += 1;
	}
	if (misses >= TXT_MISSING_LIMIT) {
		await transition(orgId, row, "active", { ...fail("txt_missing"), txtMissingCount: misses });
		return;
	}
	const change: Change = { txtMissingCount: misses };
	if (deps.cloudflare && row.cfCustomHostnameId) {
		try {
			const cf = await deps.cloudflare.get(row.cfCustomHostnameId);
			if (cf.status === "moved") Object.assign(change, fail("cloudflare_moved"));
			else if (HOSTNAME_FAILED.has(cf.status)) Object.assign(change, fail("cloudflare_rejected"));
			change.cfSslStatus = cf.sslStatus;
		} catch (error) {
			if (!(error instanceof CloudflareError)) throw error;
			if (error.isNotFound) Object.assign(change, fail("cloudflare_deleted"));
			// Other errors: keep the domain as it is; the next daily check tries again.
		}
	}
	await transition(orgId, row, "active", change);
}

/** Deletes the Cloudflare hostname, then the row. A failed Cloudflare delete leaves the row `removing` for a retry. */
export async function finishRemoval(orgId: string, row: OrganizationDomainRow, deps: ProcessDeps): Promise<boolean> {
	if (row.cfCustomHostnameId) {
		if (!deps.cloudflare) return false;
		try {
			await deps.cloudflare.delete(row.cfCustomHostnameId);
		} catch (error) {
			if (!(error instanceof CloudflareError)) throw error;
			return false;
		}
		// Clear the id first: the delete trigger queues a Cloudflare cleanup for any row that still names one.
		await transition(orgId, row, "removing", { cfCustomHostnameId: null });
	}
	await withOrgContext(orgId, () => db.delete(table).where(and(eq(table.id, row.id), eq(table.status, "removing"))));
	dropCached(row.hostname);
	return true;
}

/**
 * One check of one domain: leases it, then moves it along the status machine. Returns the row as it is afterwards, or
 * `undefined` when it was not due (another pass has it, or it checked less than a minute/5 minutes ago).
 */
export async function checkDomain(
	orgId: string,
	id: string,
	mode: Mode,
	deps: ProcessDeps = defaultProcessDeps(),
): Promise<{ row: OrganizationDomainRow | undefined; leased: boolean }> {
	const leased = await withOrgContext(orgId, () => lease(id, mode));
	if (!leased) return { row: await reread(orgId, id), leased: false };
	const { timedOut, ...row } = leased;
	if (row.status === "pending") {
		if (timedOut) {
			await transition(orgId, row, "pending", fail("verification_timeout"));
		} else if ((await deps.checkTxt(row.hostname, row.verificationToken)) === "proved") {
			const verified = await transition(orgId, row, "pending", {
				status: "verified",
				verifiedAt: sql`now()`,
				txtMissingCount: 0,
				failureReason: null,
			});
			if (verified) await progressVerified(orgId, verified, deps);
		}
	} else if (row.status === "verified") {
		await progressVerified(orgId, row, deps);
	} else if (row.status === "active") {
		await checkActive(orgId, row, mode, deps);
	} else if (row.status === "removing") {
		await finishRemoval(orgId, row, deps);
	}
	return { row: await reread(orgId, id), leased: true };
}

/** Marks a domain `removing` (it stops resolving at once), then tries to finish the removal. */
export async function startRemoval(
	orgId: string,
	id: string,
	deps: ProcessDeps = defaultProcessDeps(),
): Promise<boolean> {
	const [row] = await withOrgContext(orgId, () =>
		db
			.update(table)
			.set({ status: "removing" })
			.where(and(eq(table.id, id), ne(table.status, "removing")))
			.returning(),
	);
	if (row) dropCached(row.hostname);
	const current = row ?? (await reread(orgId, id));
	if (!current) return false;
	await finishRemoval(orgId, current, deps);
	return true;
}
