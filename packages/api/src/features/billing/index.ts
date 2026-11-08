// CAREEROS (P3-T04): the public surface of billing for the server's HTTP adapters and the scheduler.
import { runBillingJobs } from "@careeros/billing";

export { consumeBillingLimit } from "./rate-limit";
export { decideFakeCheckout, readFakeCheckout } from "./fake";
export { processBillingWebhook, type WebhookResult } from "./webhook";
export { runBillingJobs };

/** The scheduler ticks every minute; the billing job runs on every fifteenth minute of wall-clock time at most. */
export const BILLING_JOB_INTERVAL_MS = 15 * 60 * 1000;

let lastRun = 0;

/**
 * The billing work of one scheduler tick: runs the billing job when 15 minutes have passed since this process last ran
 * it. The job itself is idempotent and safe on several instances (see packages/billing/src/jobs.ts), so the throttle
 * only saves work and needs no coordination.
 */
export async function runScheduledBillingWork(now: number = Date.now()): Promise<void> {
	if (now - lastRun < BILLING_JOB_INTERVAL_MS) return;
	lastRun = now;
	const result = await runBillingJobs();
	if (result.changed > 0 || result.failed > 0)
		console.info(`[billing] job due=${result.due} changed=${result.changed} failed=${result.failed}`);
}
