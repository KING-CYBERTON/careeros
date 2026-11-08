import { timingSafeEqual } from "node:crypto";
import { runCareerJobs } from "@reactive-resume/api/features/career/jobs";
// CAREEROS (P4-T02): the cron tick also runs due job discovery sources
import { runDiscoveryJobs } from "@reactive-resume/api/features/discovery/scheduler";
import { reportStorageCleanupSummary, runStorageCleanup } from "@reactive-resume/api/features/storage/cleanup";
import { env } from "@reactive-resume/env/server";

export async function handleCareerJobs(request: Request): Promise<Response> {
	const headers = { "Cache-Control": "no-store" };
	if (!env.CRON_SECRET) return new Response(null, { status: 404, headers });
	const supplied = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
	if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
		return new Response(null, { status: 401, headers });
	// The deployment's one-minute cron also drains durable post-delete storage cleanup. A cleanup failure must not
	// hide or repeat the career tick that already ran.
	const [career] = await Promise.all([
		runCareerJobs(),
		// CAREEROS (P4-T02): bounded, so a one-minute cron invocation stays inside its time limit; what does not fit waits
		runDiscoveryJobs({ maxSources: 3, budgetMs: 150_000 }).catch(() =>
			console.error("[discovery] Scheduled work failed. Due sources will retry on a later tick."),
		),
		runStorageCleanup({ limit: 200 })
			.then(reportStorageCleanupSummary)
			.catch(() => console.error("[storage-cleanup] Scheduled work failed. Pending jobs will retry on a later tick.")),
	]);
	return Response.json(career, { headers });
}
