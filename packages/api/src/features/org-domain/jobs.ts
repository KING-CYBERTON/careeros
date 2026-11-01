import type { CloudflareClient } from "./cloudflare";
import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { checkDomain, defaultProcessDeps, type ProcessDeps } from "./process";

// CAREEROS (P2-T06, D9 pattern): the scheduler has no organization. A definer function lists the ids of the domains
// that are due (database time: pending, verified and removing every 5 minutes, active every 24 hours), and each is
// processed inside `withOrgContext` for its own organization. One failing domain is logged and does not stop the
// others. The same pass retries the Cloudflare hostnames of deleted organizations.

const BATCH = 20;
let running = false;

export type OrgDomainJobSummary = { checked: number; failed: number; cleaned: number };

/** Deletes the Cloudflare hostnames queued by deleted organizations, 20 at a time, with a growing pause between tries. */
export async function drainCloudflareCleanup(cloudflare: CloudflareClient): Promise<number> {
	// Taking a row moves its next attempt 10 minutes on, so another server instance does not take it too.
	const { rows } = await db.execute<{ cf_custom_hostname_id: string; attempts: number }>(sql`
		update organization_domain_cf_cleanup c
		set next_attempt_at = now() + interval '10 minutes'
		where c.cf_custom_hostname_id in (
			select q.cf_custom_hostname_id from organization_domain_cf_cleanup q
			where q.next_attempt_at <= now() order by q.next_attempt_at limit ${BATCH} for update skip locked
		)
		returning c.cf_custom_hostname_id, c.attempts`);
	let cleaned = 0;
	for (const row of rows) {
		try {
			await cloudflare.delete(row.cf_custom_hostname_id);
			await db.execute(
				sql`delete from organization_domain_cf_cleanup where cf_custom_hostname_id = ${row.cf_custom_hostname_id}`,
			);
			cleaned += 1;
		} catch {
			// The client logged the status and codes. Back off: 10 minutes, doubling per attempt, at most 6 hours.
			await db.execute(sql`
				update organization_domain_cf_cleanup
				set attempts = attempts + 1,
					next_attempt_at = now() + least(interval '10 minutes' * power(2, least(attempts, 6)), interval '6 hours')
				where cf_custom_hostname_id = ${row.cf_custom_hostname_id}`);
		}
	}
	return cleaned;
}

/**
 * One scheduled pass. Does nothing when Cloudflare for SaaS is not configured. Safe to run on every tick and from
 * several server instances: a domain is leased for its interval before it is checked.
 */
export async function runOrgDomainJobs(deps: ProcessDeps = defaultProcessDeps()): Promise<OrgDomainJobSummary> {
	const summary: OrgDomainJobSummary = { checked: 0, failed: 0, cleaned: 0 };
	if (!deps.cloudflare || running) return summary;
	running = true;
	try {
		const { rows: due } = await db.execute<{ id: string; organization_id: string }>(
			sql`select id, organization_id from careeros_org_domains_due(${BATCH})`,
		);
		for (const { id, organization_id: organizationId } of due) {
			try {
				const { leased } = await checkDomain(organizationId, id, "job", deps);
				if (leased) summary.checked += 1;
			} catch (error) {
				summary.failed += 1;
				// Name and domain id only: an error from the driver or the network could carry values.
				console.error(
					`[org-domain] Check failed for organization ${organizationId}, domain ${id}: ${error instanceof Error ? error.name : "error"}`,
				);
			}
		}
		try {
			summary.cleaned = await drainCloudflareCleanup(deps.cloudflare);
		} catch (error) {
			console.error(`[org-domain] Cloudflare cleanup failed: ${error instanceof Error ? error.name : "error"}`);
		}
		return summary;
	} finally {
		running = false;
	}
}
