// CAREEROS (P2-T05): expired sign-in handoffs go in the same scheduled pass
import { purgeExpiredHandoffs } from "@reactive-resume/api/features/auth-handoff";
// CAREEROS (P2-T06): organization custom domains are checked in the same pass
import { runOrgDomainJobs } from "@reactive-resume/api/features/org-domain";
import { reportStorageCleanupSummary, runStorageCleanup } from "@reactive-resume/api/features/storage/cleanup";

/** Retries durable post-delete storage cleanup. PostgreSQL leases jobs so server instances don't duplicate work. */
export function startStorageCleanupScheduler() {
	let stopped = false;
	let inFlight: Promise<void> | null = null;

	const tick = () => {
		if (stopped || inFlight) return;
		inFlight = Promise.resolve()
			.then(() => runStorageCleanup({ limit: 200 }))
			.then(reportStorageCleanupSummary)
			// CAREEROS (P2-T05): a failed purge is retried on the next tick and must not stop storage cleanup.
			.then(() => purgeExpiredHandoffs().catch(() => console.error("[handoff] Purging expired handoffs failed.")))
			// CAREEROS (P2-T06): only domains that are due are touched (database time); a failure here is retried on a later tick.
			.then(() => runOrgDomainJobs().catch(() => console.error("[org-domain] Scheduled work failed.")))
			.then(() => undefined)
			.catch(() => {
				console.error("[storage-cleanup] Scheduled work failed. Pending jobs will retry on a later tick.");
			})
			.finally(() => {
				inFlight = null;
			});
	};

	const interval = setInterval(tick, 60_000);
	interval.unref();
	tick();

	return {
		stop: async () => {
			stopped = true;
			clearInterval(interval);
			await inFlight;
		},
	};
}
