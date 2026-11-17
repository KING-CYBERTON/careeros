import { runDiscoveryJobs } from "@reactive-resume/api/features/discovery/scheduler";

// CAREEROS (P4-T02): the long-running Node server owns discovery ticks, like the career scheduler's, on a loop of its
// own: a discovery run can take minutes and must not hold up career jobs. PostgreSQL coordinates work across server
// instances (a source is claimed by one conditional UPDATE), and the kill switch FLAG_DISABLE_DISCOVERY_SCHEDULER is
// read by `runDiscoveryJobs` itself.
export function startDiscoveryScheduler() {
	let stopped = false;
	let inFlight: Promise<void> | null = null;

	const tick = () => {
		if (stopped || inFlight) return;
		inFlight = Promise.resolve()
			.then(() => runDiscoveryJobs())
			.then(() => undefined)
			.catch(() => {
				console.error("[discovery] Scheduled work failed. Due sources will retry on a later tick.");
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
