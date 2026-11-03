import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { startStorageCleanupScheduler } from "./storage-cleanup";

const run = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const report = vi.hoisted(() => vi.fn());
vi.mock("@reactive-resume/api/features/storage/cleanup", () => ({
	runStorageCleanup: run,
	reportStorageCleanupSummary: report,
}));

// CAREEROS (P2-T06): organization domain checks run in the same pass
const orgDomains = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock("@reactive-resume/api/features/org-domain", async (importOriginal) => ({
	...(await importOriginal<typeof import("@reactive-resume/api/features/org-domain")>()),
	runOrgDomainJobs: orgDomains,
}));

// CAREEROS (P3-T04): the billing deadlines run in the same pass
const billing = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("@reactive-resume/api/features/billing", () => ({ runScheduledBillingWork: billing }));

const purge = vi.hoisted(() => vi.fn<() => Promise<number>>());
vi.mock("@reactive-resume/api/features/auth-handoff", () => ({ purgeExpiredHandoffs: purge }));

beforeEach(() => {
	purge.mockReset().mockResolvedValue(0);
	billing.mockReset().mockResolvedValue(undefined);
	orgDomains.mockReset().mockResolvedValue({ checked: 0, failed: 0, cleaned: 0 });
	vi.useFakeTimers();
	run.mockReset().mockResolvedValue({ completed: 0, missing: 0, failed: 0, partial: 0, abandoned: 0 });
	report.mockReset();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("starts immediately, skips overlapping ticks, and drains active work before stopping", async () => {
	const first = Promise.withResolvers<unknown>();
	run.mockReturnValueOnce(first.promise);
	const scheduler = startStorageCleanupScheduler();
	await vi.advanceTimersByTimeAsync(0);
	expect(run).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(120_000);
	expect(run).toHaveBeenCalledTimes(1);

	first.resolve({ completed: 1 });
	await vi.advanceTimersByTimeAsync(60_000);
	expect(run).toHaveBeenCalledTimes(2);

	const stopped = vi.fn();
	const drain = scheduler.stop().then(stopped);
	await vi.advanceTimersByTimeAsync(120_000);
	await drain;
	expect(stopped).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(60_000);
	expect(run).toHaveBeenCalledTimes(2);
});

it("forwards a resolved failure summary to the sanitized signal", async () => {
	const summary = { completed: 0, missing: 0, failed: 1, partial: 1, abandoned: 1 };
	run.mockResolvedValueOnce(summary);
	const scheduler = startStorageCleanupScheduler();
	try {
		await vi.advanceTimersByTimeAsync(0);
		expect(report).toHaveBeenCalledWith(summary);
	} finally {
		await scheduler.stop();
	}
});

it("logs a failed tick without exposing cleanup payloads, then retries later", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	run.mockRejectedValueOnce(new Error("private storage key"));
	const scheduler = startStorageCleanupScheduler();
	try {
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toHaveBeenCalledOnce();
		expect(JSON.stringify(log.mock.calls)).not.toContain("private storage key");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(run).toHaveBeenCalledTimes(2);
	} finally {
		await scheduler.stop();
	}
});

// CAREEROS (P2-T06)
it("runs the organization domain checks each tick and logs a failure without stopping the scheduler", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	orgDomains.mockRejectedValueOnce(new Error("private cloudflare detail"));
	const scheduler = startStorageCleanupScheduler();
	try {
		await vi.advanceTimersByTimeAsync(0);
		expect(orgDomains).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith("[org-domain] Scheduled work failed.");
		expect(JSON.stringify(log.mock.calls)).not.toContain("private cloudflare detail");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(orgDomains).toHaveBeenCalledTimes(2);
	} finally {
		await scheduler.stop();
	}
});

// CAREEROS (P3-T04)
it("runs the billing work each tick and logs a failure without stopping the scheduler", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	billing.mockRejectedValueOnce(new Error("private billing detail"));
	const scheduler = startStorageCleanupScheduler();
	try {
		await vi.advanceTimersByTimeAsync(0);
		expect(billing).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith("[billing] Scheduled work failed.");
		expect(JSON.stringify(log.mock.calls)).not.toContain("private billing detail");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(billing).toHaveBeenCalledTimes(2);
	} finally {
		await scheduler.stop();
	}
});
